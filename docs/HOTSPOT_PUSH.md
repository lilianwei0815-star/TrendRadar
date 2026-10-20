# 萌宠创作热点推送

## 当前入口

- 工作流：`.github/workflows/hotspot-push.yml`，Actions 中显示为“萌宠创作热点推送”。
- 程序：`scripts/hotspot_push.py`，仅使用 Python 3.12 标准库。
- 平台与推送数量：`config/hotspot.json`。
- 六类关键词、24 个全局屏蔽词：`config/frequency_words.txt`。
- 原 `crawler.yml` 和七天签到工作流已移除，新入口不需要签到。
- 原 TrendRadar 其他模块保留，但不会由新定时任务调用；旧 `config/config.yaml` 中 AI、RSS 等设置不控制新入口。

## 定时与筛选

每天北京时间 08:00、12:00、18:00，GitHub cron 为 `0 0,4,10 * * *`（UTC）。
GitHub Actions 的实际启动时间可能延迟，配置不能保证精确到分钟送达。

覆盖 11 个公开热榜：头条、百度、华尔街见闻、澎湃、B站、财联社、凤凰、贴吧、微博、抖音、知乎。
依赖 NewsNow 公共 API 的可用性。这里的多平台聚合不代表整个互联网，也不扫描平台全部视频、私有内容或指定博主历史作品；热榜没有出现的低粉爆款可能无法发现。

按标题筛选，不是语义舆情判断。每组关键词任意命中即可；单行中空格分隔的词需要同时出现，顺序不限。
全局屏蔽词优先于所有正向词，例如“宠物 点赞”会被屏蔽词“点赞”排除，“社会关注”会被“关注”排除。这是用户指定的严格过滤规则。

同标题跨平台合并，保留来源列表。同一标题若有多个分类匹配，按最具体的关键词分类。
每次展示当前匹配内容，最多 60 条，六个类别轮流取条，减少泛社会热点挤占萌宠专项内容；不同推送时段仍在榜的内容可能重复。

## 摘要与消息

每条包含标题、可点击原文链接、中文摘要、来源。摘要优先取数据源描述，其次取原文页面的 `og:description` / `description` / `twitter:description`。
会排除明显验证码提示、非中文描述和与标题缺乏关联的简介。摘要为来源摘录，不调用 AI API、不增加推断事实。
如果平台只提供标题，或原文需要登录、被反爬拦截、没有有效描述，会明确显示“暂未获取到可靠的中文原文摘要，请查看原文”，不会伪造摘要。

消息按完整 UTF-8 JSON 大小自动分批，低于飞书自定义机器人 20 KB 请求限制。
所有平台都失败时，任务会失败，不会发“暂无新闻”误导；部分失败会在推送中列出。
飞书必须返回业务成功码 0 才算发送成功。网络异常不会把 Webhook 写进日志。

## 密钥设置

在仓库 Settings → Secrets and variables → Actions 中创建或更新：

`FEISHU_WEBHOOK_URL`

值为飞书群自定义机器人的完整 Webhook。不要将它写入代码、配置文件、Issue 或提交记录。
当前 GitHub 连接不提供 Secrets 管理，因此该密钥需要仓库所有者在 GitHub 设置页面确认。
如果机器人配置了关键词、签名或 IP 限制，需要让机器人允许当前发送方式；程序收到非零业务码会报告失败，不会自动降低机器人安全设置。

## 手动验证

Actions → 萌宠创作热点推送 → Run workflow，选择 master：

- `test`：仅发连接测试消息，不验证新闻来源和定时调度。
- `normal`：抓取、筛选、提取摘要并推送当前热点。
- `preview`：抓取并生成预览，不发消息；在 Artifacts 下载 `hotspot-report-运行编号`。

修改相关工作流、程序或配置并推送到 master 时，只会自动发送连接测试。定时运行会执行正常抓取推送。

本地验证：

```bash
python -m unittest discover -s tests/hotspot -v
python scripts/hotspot_push.py --mode test --dry-run
python scripts/hotspot_push.py --dry-run --output output/hotspot-preview.json
```

如果 Actions 长期显示 queued、jobs 接口为空且无法取消，这是运行尚未进入程序执行的现象。新配置本身不能修复 GitHub 后台状态，应将运行编号和截图交给 GitHub 排查。
