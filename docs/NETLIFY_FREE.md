# Netlify Free 飞书热点推送

此部署使用 Netlify 的 **Free** 套餐，不购买套餐、域名、数据库、付费插件或额外积分。官方当前每月提供 300 积分硬限额，耗尽后暂停，不自动扣费。云平台规则会变化，以创建时显示的 Free 套餐为准。

## 部署配置

导入仓库 `lilianwei0815-star/TrendRadar` 的 `master` 分支，读取根目录 `netlify.toml`。基础目录为 `cloud/netlify`，构建命令 `npm test`，发布目录 `public`，函数目录 `functions`。只需 Node.js 22，不安装第三方 npm 依赖。

构建时从原有 `config/hotspot.json` 与 `config/frequency_words.txt` 生成配置模块。因此六类关注词、24 个屏蔽词与 11 个公开热榜来源均沿用原配置。空格短语按 AND 匹配，任一屏蔽词命中标题则排除，仍保留用户指定的“关注”“点赞”等屏蔽词。

在 Netlify 环境变量中设置：

| 名称 | 内容 |
| --- | --- |
| `FEISHU_WEBHOOK_URL` | 用户的飞书机器人地址，仅存于云端环境变量 |
| `HOTSPOT_INTERNAL_SECRET` | 独立生成的至少 32 字符随机内部调用密钥 |
| `HOTSPOT_MODE` | 正式为 `normal`；`test` 只测试连接；`preview` 只抓取并在日志显示统计、不发送 |

密钥不要填写到 GitHub 文件、`netlify.toml` 或公开网页。Netlify 自动提供 `URL` 环境变量，用于定时函数调用同站点后台函数。

## 执行与验证

`hotspot-schedule` 使用 UTC `0 0,4,10 * * *`，对应北京时间每天 **08:00、12:00、18:00**。定时函数本身的 30 秒限时只用于启动后台任务，实际抓取和推送由 `hotspot-background` 执行，内部任务总网络时限为 240 秒。内部调用使用 HMAC-SHA256 签名并检查时间戳，未经验证的调用不抓取、不发送。

部署成功后，在 Netlify 的 Functions 中手动运行 `hotspot-schedule`。定时函数日志中的“已接受调用”只说明后台任务已启动；必须同时确认后台日志 `delivered` 大于 0、飞书群收到正式热点内容，才算云端推送测试成功。随后还需核对至少一次按时自动触发。首次部署不会证明下一次定时任务一定成功。

后台函数遇到发送错误时会记录安全错误信息并结束，不抛异常让平台重发整份报告，避免部分消息已送达后自动重复发送。全平台失败则停止，不发送“暂无新闻”。失败运行需检查后台日志；平台的 HTTP 202 不代表消息已送达。

## 费用与限制

不启用付费计划。Free 每月 300 积分为账户共享，成功生产部署也消耗积分，避免频繁重复部署。默认 1 GB 函数按当前 10 积分/GB·小时测算：假设 31 天每天 3 次、每次 60 秒，后台计算约 15.5 积分/月；这是估算，不含构建、部署和其他项目用量。额度耗尽会暂停，仍需关注控制台用量。

只覆盖配置中的公开热榜，不等于全网全文或全部视频、低粉爆款账号监控。摘要优先使用来源描述、其次摘录原文 meta 描述；无法取得可靠中文摘要时明确标记摘要暂缺，不编造。每次至多 60 条匹配记录，单次同标题跨平台合并，不做跨天增量去重。第三方热榜、原文页面和飞书接口的可访问性须在实际云端测试。

云端验收前保留旧 GitHub 工作流用于排查；云端验收后移除旧工作流的 cron，保留手动调试入口，以免 GitHub 恢复后重复定时推送。

参考：
- https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/
- https://docs.netlify.com/build/functions/scheduled-functions/
- https://docs.netlify.com/build/functions/background-functions/
