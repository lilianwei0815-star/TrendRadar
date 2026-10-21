#!/usr/bin/env python3
"""Fetch public hot lists, apply explicit keywords, and send sourced Feishu digests.

Standard library only. Credentials are read exclusively from environment variables.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", str(value)))).strip()


def load_rules(path: Path) -> tuple[list[tuple[str, list[str]]], list[str]]:
    groups, blocked = [], []
    current = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("!"):
            blocked.append(line[1:].casefold())
        elif line.startswith("[") and line.endswith("]"):
            current = (line[1:-1], [])
            groups.append(current)
        elif current is not None:
            current[1].append(line)
    if not groups or not blocked:
        raise ValueError("关键词分组或屏蔽词为空")
    return groups, blocked


def classify(title: str, groups: list, blocked: list[str]) -> str | None:
    text = unicodedata.normalize("NFKC", title).casefold()
    if any(word in text for word in blocked):
        return None
    matches = []
    for index, (name, words) in enumerate(groups):
        for phrase in words:
            tokens = unicodedata.normalize("NFKC", phrase).casefold().split()
            if tokens and all(token in text for token in tokens):
                matches.append((sum(map(len, tokens)), -index, name))
    return max(matches)[2] if matches else None


def allowed_url(url: str, domain: str) -> bool:
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or "").lower()
        return (p.scheme == "https" and not p.username and not p.password
                and p.port in (None, 443)
                and (host == domain or host.endswith("." + domain)))
    except ValueError:
        return False


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=12) as response:
        return json.loads(response.read(3_000_000).decode("utf-8"))


def fetch_source(args: tuple[str, dict]) -> tuple[dict, list, str | None]:
    api, source = args
    url = api + "?" + urllib.parse.urlencode({"id": source["id"]}) + "&latest"
    last_error = "unknown"
    for attempt in range(2):
        try:
            data = get_json(url)
            if data.get("status") not in ("success", "cache") or not isinstance(data.get("items"), list):
                raise ValueError("unexpected API response")
            return source, data["items"], None
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            last_error = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
            if attempt == 0:
                time.sleep(1)
    return source, [], last_error


def normalize_items(results: list, groups: list, blocked: list[str]) -> list[dict]:
    items, seen = [], {}
    for source, raw_items, error in results:
        if error:
            continue
        for rank, raw in enumerate(raw_items, 1):
            if not isinstance(raw, dict) or not isinstance(raw.get("title"), str):
                continue
            title = clean_text(raw["title"])
            category = classify(title, groups, blocked)
            url = raw.get("url") or raw.get("mobileUrl") or ""
            url = unescape(url) if isinstance(url, str) else ""
            if not category or not isinstance(url, str) or not allowed_url(url, source["expected_domain"]):
                continue
            key = re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", title).casefold())
            if key in seen:
                previous = seen[key]
                if source["name"] not in previous["sources"]:
                    previous["sources"].append(source["name"])
                previous["rank"] = min(previous["rank"], rank)
                continue
            description = next((clean_text(raw[k]) for k in ("description", "summary", "desc")
                                if isinstance(raw.get(k), str) and clean_text(raw[k])), "")
            item = {"title": title, "url": url, "category": category,
                    "sources": [source["name"]], "rank": rank,
                    "domain": source["expected_domain"], "description": description}
            seen[key] = item
            items.append(item)
    return items


def select_items(items: list[dict], groups: list, limit: int) -> list[dict]:
    """Round robin prevents broad social topics from hiding niche categories."""
    buckets = {name: sorted((x for x in items if x["category"] == name),
                            key=lambda x: (-len(x["sources"]), x["rank"])) for name, _ in groups}
    selected = []
    while len(selected) < limit and any(buckets.values()):
        for name, _ in groups:
            if buckets[name] and len(selected) < limit:
                selected.append(buckets[name].pop(0))
    return selected


class ArticleMetadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.descriptions = {}

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "meta":
            return
        fields = {k.lower(): v for k, v in attrs if v is not None}
        key = (fields.get("property") or fields.get("name") or "").lower()
        if key in ("og:description", "description", "twitter:description"):
            self.descriptions[key] = clean_text(fields.get("content", ""))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, domain):
        self.domain = domain

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_url(newurl, self.domain):
            raise ValueError("article redirect outside source domain")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def useful_description(description: str, title: str) -> bool:
    if len(description) < 20 or description == title:
        return False
    if not re.search(r"[\u4e00-\u9fff]", description):
        return False
    boilerplate = ("请开启javascript", "启用javascript", "验证码", "安全验证", "访问验证", "登录后查看",
                   "专题，为您展现", "相关内容及最新", "百度一下，你就知道")
    if any(x in description.casefold() for x in boilerplate):
        return False
    # A site-wide slogan is not a summary of this particular article.
    shared = set(re.findall(r"[\u4e00-\u9fff]", title)) & set(description)
    return len(shared) >= min(4, len(set(re.findall(r"[\u4e00-\u9fff]", title))))


def summarize(item: dict) -> dict:
    item = dict(item)
    description = item["description"]
    origin = "热榜来源摘要"
    if not useful_description(description, item["title"]):
        description = ""
        try:
            req = urllib.request.Request(item["url"], headers={"User-Agent": UA})
            opener = urllib.request.build_opener(SafeRedirect(item["domain"]))
            with opener.open(req, timeout=7) as response:
                if "html" not in response.headers.get("Content-Type", "").lower():
                    raise ValueError("not an HTML article")
                raw = response.read(800_000)
                encoding = response.headers.get_content_charset() or "utf-8"
                try:
                    html = raw.decode(encoding, errors="replace")
                except LookupError:
                    html = raw.decode("utf-8", errors="replace")
                parser = ArticleMetadata()
                parser.feed(html)
                description = next((parser.descriptions[k] for k in
                                    ("og:description", "description", "twitter:description")
                                    if useful_description(parser.descriptions.get(k, ""), item["title"])), "")
                origin = "原文摘要摘录"
        except (OSError, ValueError):
            pass
    if description:
        item["summary"] = description[:180] + ("…" if len(description) > 180 else "")
        item["summary_origin"] = origin
    else:
        item["summary"] = "暂未获取到可靠的中文原文摘要，请查看原文。"
        item["summary_origin"] = "摘要暂缺"
    return item


def text_row(text: str) -> list[dict]:
    return [{"tag": "text", "text": text}]


def make_payloads(items: list[dict], config: dict, failed: list[str], total: int, mode: str) -> list[dict]:
    stamp = datetime.now(ZoneInfo(config["timezone"])).strftime("%Y-%m-%d %H:%M")
    if mode == "test":
        content = [text_row("连接测试：飞书机器人接口已收到请求。此消息不代表新闻抓取或定时任务已验证。"),
                   text_row("计划：北京时间每天 08:00、18:00，标题＋原文链接＋中文摘要。")]
    else:
        content = [text_row(f"本次筛选匹配 {total} 条，展示 {len(items)} 条；同标题跨平台合并。")]
        if not items:
            content.append(text_row("本次暂无匹配内容。已按全部屏蔽词过滤。"))
        for index, item in enumerate(items, 1):
            content.extend([
                text_row(f"{index}. 【{item['category']}】{item['title']}"),
                [{"tag": "a", "text": "查看原文", "href": item["url"]}],
                text_row(f"摘要：{item['summary']}"),
                text_row(f"来源：{'、'.join(item['sources'])}｜{item['summary_origin']}"),
            ])
        if failed:
            content.append(text_row("部分平台抓取失败：" + "、".join(failed)))
        content.append(text_row("覆盖配置中的公开热榜，不包含平台全部视频或私有数据；摘要仅摘录来源。"))
    # Feishu custom bots have a 20 KB request limit; measure complete JSON in UTF-8.
    def payload(rows, part=1):
        return {"msg_type": "post", "content": {"post": {"zh_cn": {
            "title": f"萌宠创作热点｜{stamp}｜第{part}条消息", "content": rows}}}}
    batches, rows = [], []
    for row in content:
        if rows and len(json.dumps(payload(rows + [row], len(batches)+1), ensure_ascii=False).encode()) > 17000:
            batches.append(payload(rows, len(batches)+1))
            rows = []
        rows.append(row)
    if rows:
        batches.append(payload(rows, len(batches)+1))
    return batches


def send_feishu(payloads: list[dict], webhook: str) -> None:
    p = urllib.parse.urlsplit(webhook)
    if p.scheme != "https" or p.hostname != "open.feishu.cn" or not p.path.startswith("/open-apis/bot/v2/hook/"):
        raise ValueError("FEISHU_WEBHOOK_URL 格式不正确")
    for index, payload in enumerate(payloads, 1):
        req = urllib.request.Request(webhook, data=json.dumps(payload, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.loads(response.read(100_000).decode())
        except (OSError, ValueError):
            # Do not log exceptions containing a webhook credential.
            raise RuntimeError("飞书发送请求失败，未记录密钥；请检查网络和机器人配置") from None
        code = result.get("code", result.get("StatusCode"))
        if code != 0:
            raise RuntimeError(f"飞书拒绝消息（错误码 {code}）；请检查机器人关键词、签名或IP限制")
        print(f"飞书已确认接收第 {index}/{len(payloads)} 条消息")
        if index < len(payloads):
            time.sleep(1)


def run(mode: str, dry_run: bool = False, output: Path | None = None) -> int:
    config = json.loads((ROOT / "config/hotspot.json").read_text(encoding="utf-8"))
    if not dry_run and not os.environ.get("FEISHU_WEBHOOK_URL"):
        raise ValueError("缺少 GitHub Actions Secret：FEISHU_WEBHOOK_URL")
    items, failed, total = [], [], 0
    if mode != "test":
        groups, blocked = load_rules(ROOT / "config/frequency_words.txt")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(fetch_source, [(config["api_url"], s) for s in config["sources"]]))
        failed = [source["name"] for source, _, error in results if error]
        for source, raw, error in results:
            print(f"{source['name']}：" + (f"抓取失败（{error}）" if error else f"获取 {len(raw)} 条"))
        if len(failed) == len(config["sources"]):
            raise RuntimeError("所有平台均抓取失败，停止发送，避免把抓取失败当成暂无新闻")
        selected = normalize_items(results, groups, blocked)
        total = len(selected)
        selected = select_items(selected, groups, config["max_items"])
        with ThreadPoolExecutor(max_workers=6) as pool:
            items = list(pool.map(summarize, selected))
        print(f"匹配 {total} 条，展示 {len(items)} 条，有摘要 {sum(x['summary_origin'] != '摘要暂缺' for x in items)} 条")
    payloads = make_payloads(items, config, failed, total, mode)
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"mode": mode, "matched": total, "items": items,
                                      "failed_sources": failed, "messages": payloads}, ensure_ascii=False, indent=2), encoding="utf-8")
    if dry_run:
        print(f"预览完成：{len(payloads)} 条消息，未发送")
    else:
        send_feishu(payloads, os.environ["FEISHU_WEBHOOK_URL"].strip())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("normal", "test"), default="normal")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        return run(args.mode, args.dry_run, args.output)
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
