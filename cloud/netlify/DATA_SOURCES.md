# Douyin video integration

DataXAPI was tested in its signed-in Playground on 2026-10-21. Low-fan charts,
AI-pet and AI-film searches, and video detail requests returned actual works.
Chart and detail counters differed substantially; only detail counters are sent.
This is a discovery feed, not exhaustive Douyin monitoring.

## Runtime activation

The integration is OFF until `DATAXAPI_DOUYIN_ENABLED=true` and
`DATAXAPI_API_KEY` are set for the production Functions runtime in Netlify.
Keep the key secret, out of Git, build variables, previews and chat. Do not
reveal/copy an existing key through browser automation. The account owner can
enter it directly in Netlify's secret environment-variable form.

Deployment builds, tests and the public source probe do not call credential
sources. The existing 08:00 / 18:00 Beijing schedule is unchanged.

## Limits and evidence

Each digest makes at most one low-fan chart request, one `AI萌宠` search and one
`AI短片` search, followed by at most six video-detail requests. No pagination,
automatic retries or paid fallback. Current assumed prices are $0.002 per chart
or detail, $0.020 per search. A hard request budget is $0.054 per digest, with
per-call `X-Max-Price` headers. This is a per-digest ceiling, not a monthly
account limit. Insufficient balance or auth/rate errors stop further calls.
No recharge or subscription is created by the code. The tested account's
remaining $0.056 trial credit covers at most one full run at that ceiling.

Only video URLs matching the returned ID and works published in the past seven
days are considered. Image posts, tutorials and invalid counters are excluded.
Ordinary works require 100,000 likes; AI works 10,000; low-fan leads can qualify
at 5,000 likes if chart/search followers are at most 10,000 and likes at least
twice that follower count. These are adjustable discovery thresholds, not an
official viral-video definition. Every selected work must pass a detail lookup
and the same engagement thresholds again before it enters the digest.

Fan counts can be older chart/search measurements, so they are used only for
lead selection and are not presented as verified current fan counts. Playback
counts are not provided by the tested detail/search endpoints and are omitted.
AI categories come from the work's title/caption, not from watching it. Chinese
summaries quote the video caption; no frame transcription or invented story.
The digest includes the interaction-data query timestamp.

To disable, set `DATAXAPI_DOUYIN_ENABLED=false`; other feeds continue normally.
Verify the first scheduled run and actual Feishu receipt before declaring the
integration live. Remaining trial credit is not a sustainable production budget.
