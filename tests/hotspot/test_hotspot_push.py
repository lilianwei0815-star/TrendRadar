import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("hotspot_push", ROOT / "scripts/hotspot_push.py")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class HotspotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.groups, cls.blocked = h.load_rules(ROOT / "config/frequency_words.txt")
        cls.config = json.loads((ROOT / "config/hotspot.json").read_text())

    def test_six_categories_and_all_blocked_words(self):
        self.assertEqual(len(self.groups), 6)
        self.assertEqual(len(self.blocked), 24)
        for blocked in self.blocked:
            with self.subTest(blocked=blocked):
                self.assertIsNone(h.classify("暖心猫咪" + blocked, self.groups, self.blocked))

    def test_specific_category_wins_over_generic_cat(self):
        self.assertEqual(h.classify("AI猫咪短剧暖心上线", self.groups, self.blocked), "AI短片与动画")
        self.assertEqual(h.classify("新作：ai萌宠短片", self.groups, self.blocked), "AI萌宠博主与爆款")

    def test_space_terms_mean_all_terms_in_any_order(self):
        groups = [("专项", ["萌宠 百万赞"])]
        self.assertEqual(h.classify("百万赞的萌宠新作", groups, []), "专项")
        self.assertIsNone(h.classify("百万赞风景", groups, []))
        self.assertIsNone(h.classify("宠物点赞百万", self.groups, self.blocked))

    def test_unrelated_content_is_excluded(self):
        self.assertIsNone(h.classify("今日天气晴朗", self.groups, self.blocked))

    def test_dedup_and_domain_validation(self):
        a = {"name": "微博", "expected_domain": "weibo.com"}
        b = {"name": "头条", "expected_domain": "toutiao.com"}
        results = [(a, [{"title": "暖心猫咪回家", "url": "https://weibo.com/a"},
                        {"title": "猫咪广告", "url": "https://weibo.com/b"},
                        {"title": "狗狗回家", "url": "https://weibo.com.evil.test/x"}], None),
                   (b, [{"title": "暖心猫咪回家", "url": "https://www.toutiao.com/a"}], None)]
        items = h.normalize_items(results, self.groups, self.blocked)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["sources"], ["微博", "头条"])
        self.assertFalse(h.allowed_url("https://weibo.com@evil.test", "weibo.com"))

    def test_categories_get_balanced_coverage(self):
        items = [{"category": "a", "sources": ["s"], "rank": r} for r in range(20)]
        items += [{"category": "b", "sources": ["s"], "rank": 10}]
        selected = h.select_items(items, [("a", []), ("b", [])], 3)
        self.assertEqual([x["category"] for x in selected], ["a", "b", "a"])

    def test_summary_is_sourced_or_explicitly_missing(self):
        item = {"title": "流浪猫救助暖心故事", "url": "https://weibo.com/a", "domain": "weibo.com",
                "description": "志愿者救助流浪猫的暖心故事，记录了猫咪获救后得到照顾的过程。"}
        sourced = h.summarize(item)
        self.assertEqual(sourced["summary_origin"], "热榜来源摘要")
        with patch.object(h.urllib.request, "build_opener", side_effect=OSError):
            missing = h.summarize(dict(item, description=""))
        self.assertEqual(missing["summary_origin"], "摘要暂缺")
        self.assertIn("暂未获取", missing["summary"])
        self.assertFalse(h.useful_description("请完成安全验证后继续访问此页面内容，验证码", item["title"]))
        self.assertFalse(h.useful_description("百度贴吧-流浪猫救助暖心故事专题，为您展现优质的流浪猫救助暖心故事各类信息", item["title"]))

    def test_meta_description_parser(self):
        p = h.ArticleMetadata()
        p.feed('<meta property="og:description" content="猫咪与狗狗的暖心故事 &amp; 日常">')
        self.assertEqual(p.descriptions["og:description"], "猫咪与狗狗的暖心故事 & 日常")

    def test_real_encoded_feishu_payload_stays_under_limit(self):
        items = [{"category": "萌宠", "title": "猫"*120, "url": "https://weibo.com/a",
                  "summary": "摘要"*90, "summary_origin": "原文摘要摘录", "sources": ["微博"]} for _ in range(60)]
        payloads = h.make_payloads(items, self.config, [], 60, "normal")
        self.assertGreater(len(payloads), 1)
        for payload in payloads:
            self.assertLess(len(json.dumps(payload, ensure_ascii=False).encode()), 20000)
        rows = [row for p in payloads for row in p["content"]["post"]["zh_cn"]["content"]]
        self.assertEqual(sum(row[0]["tag"] == "a" for row in rows), 60)

    def test_feishu_error_codes_fail_run_and_do_not_log_webhook(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return b'{"code":19024}'
        hook = "https://open.feishu.cn/open-apis/bot/v2/hook/test-secret"
        with patch.object(h.urllib.request, "urlopen", return_value=Response()):
            with self.assertRaisesRegex(RuntimeError, "19024"):
                h.send_feishu([{}], hook)
        with patch.object(h.urllib.request, "urlopen", side_effect=OSError(hook)):
            try:
                h.send_feishu([{}], hook)
            except RuntimeError as exc:
                self.assertNotIn("test-secret", str(exc))
            else:
                self.fail("network failure was hidden")

    def test_test_message_does_not_claim_end_to_end_success(self):
        payloads = h.make_payloads([], self.config, [], 0, "test")
        self.assertIn("不代表新闻抓取", str(payloads))

    def test_all_sources_failing_stops_before_send(self):
        def fail(args): return args[1], [], "HTTPError"
        with patch.dict(h.os.environ, {"FEISHU_WEBHOOK_URL": "unused"}), \
             patch.object(h, "fetch_source", side_effect=fail), \
             patch.object(h, "send_feishu") as sender:
            with self.assertRaisesRegex(RuntimeError, "所有平台均抓取失败"):
                h.run("normal")
            sender.assert_not_called()


if __name__ == "__main__":
    unittest.main()
