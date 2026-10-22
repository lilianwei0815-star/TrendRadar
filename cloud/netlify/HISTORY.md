# New vs previous digest

Production background runs use the private site-wide Netlify Blobs store
`hotspot-delivery-production-v1`, key `last-successful-digest`. The snapshot
contains only SHA-256 item identifiers, a schema version, and delivery time.
It survives deployments; no API keys, webhook URLs or article text are stored.

- Compare against the last **fully delivered** normal digest, not all-time history.
- Topics match normalized titles across platforms. Videos match platform + video
  path, so tracking parameters, changed counters and renamed videos stay repeated.
- Labels: `🆕 新增`, `🔁 持续热点`, `📌 首次记录`, `⚪ 未比较`.
- Each category puts new items first and displays its new count. Selection,
  interest rules, source costs, and the 08:00/18:00 schedule are unchanged.
- First run establishes a baseline; no retrospective comparison is invented.
- Empty, test, preview, failed, or partially delivered digests do not advance it.
- Read failures show “未比较” and do not overwrite history. Save failures are
  logged after delivery and never trigger a resend. Strong reads and ETag
  conditional writes prevent stale concurrent readers from replacing a baseline.
- Title changes may split a developing news story into multiple topic entries;
  this is exact normalized-title matching, not semantic event tracking.

`@netlify/blobs` uses the Function's automatic platform configuration; no new
user credential is needed. Builds and source probes never open the store.
