# DLHD / thedaddy.li — public endpoint catalogue

Observed 2026-11-10 17:38–17:58 UTC, Chrome 131 UA, desktop. Raw artifacts in
`/private/var/folders/59/9hhfkkr14ndb1s13k3vmgn880000gn/T/opencode/`. Sizes = `size_download`.

## 1. `/api.php` — an HTML docs page, not an API
`GET https://thedaddy.li/api.php` → **200** `text/html` **28 597 B**, title "API - DLHD", body
"API Documentation — Extended". It documents a *different*, key-gated endpoint:
`GET https://thedaddy.li/daddyapi.php?key=<KEY>&endpoint=channels|schedule|info`

| request | status | body |
|---|---|---|
| `/daddyapi.php` | **401** | `{"error":"Unauthorized","message":"Missing API key","code":401}` (63 B) |
| `?endpoint=info` | **401** | same |
| `?key=test&endpoint=channels` | **401** | `{"error":"Unauthorized","message":"Invalid API key","contact":"livetvon@protonmail.com","code":401}` (99 B) |
| `?key=test&endpoint=schedule` | **401** | same |
| `OPTIONS /daddyapi.php` | **204** | `access-control-allow-origin: *`, `allow-methods: GET, OPTIONS` |

Auth = one `key` query param (no header/cookie). Rate limit: no `ratelimit-*` headers → **UNKNOWN**.
Documented schemas (unverifiable without a key): `channels` → `[{channel_name, channel_id:"491",
logo_url:"logos/x.png"|absolute}]`; `schedule` → `{success, data:{"<Day>":{"<Category>":[{time:"07:37",
event, channels:[{channel_name,channel_id,logo_url}], channels2:[]}]}}, days_count}`. The docs contradict
themselves (sample = bare array; JS sample reads `data.data`/`data.count`). **No stream URLs are
documented** — only ids; playback is always a page. Deprioritise.

## 2. `/24-7-channels.php` — 900 cards / 899 unique ids
`GET` → **200** `text/html` **208 557 B** (has stray non-UTF-8 bytes; decode with `errors="replace"`).

```html
<a class="card" href="/watch.php?id=51" data-title="abc usa" data-first="A">
  <div class="card__title">ABC USA</div><div class="">ID: 51</div></a>
```
* 900 anchors, **899 unique ids**; id **811 "SEE Denmark" appears twice** (lines 5235 + 5648).
* Grouping is **alphabetical only**: filter bar `.alphabet-filter > span[data-letter]` (all, A–Z); `data-first` = bucket (`A`…`Z`, `#`, `1`…). No sport category, no logos, no `<img>`.
* Geo/offline: **none**. `geo|offline|restricted|blocked|unavailable` matches only channel names ("Nat Geo Wild"); no status attribute exists on a card.
* Alternate list `GET /channels.php` → **200** **180 819 B**, same 899 ids, `href="/watch.php?id=51&src=main" data-title="…"` (no `data-first`). `?format=json` on either page still returns HTML.
* → `channels-24-7.json` = 900 × `{"id":51,"name":"ABC USA","group":"A"}`.

## 3. Schedule / events — 326 blocks, 2 day sections
`GET https://thedaddy.li/` → **200** `text/html` **483 708 B**.

```html
<div class="schedule__dayTitle">Tuesday 10th Nov 2026 - Schedule Time UK GMT</div>
<div class="schedule__catHeader" aria-expanded="true"><div class="card__meta">Upcoming Events</div></div>
<div class="schedule__event"><div class="schedule__eventHeader">
  <span class="schedule__time" data-time="11:00">11:00</span>
  <span class="schedule__eventTitle">🏅 Summer Youth Olympic Games | Dakar</span></div>
 <div class="schedule__channels"><a target="_blank" href="/watch.php?id=61"
   title="beIN SPORTS 1 English" data-ch="bein sports 1 english">beIN SPORTS 1 English</a>
```
* **Events link to `/watch.php?id=<N>`, not `/stream/stream-<N>.php`.** The only `/stream/` links on the page are the 8 `a.upcoming-card` carousel entries (ids 32, 40, 46, 60, 405, 891, 895).
* **Same numbering space.** `GET /stream/stream-32.php` **200** 659 796 B ends in `<iframe src="https://dembed.st/premiumtv/daddy.php?id=32">`; `stream-46.php` is byte-identical except that src. `GET /watch.php?id=32` **200** `<title>TNT Sports 2 UK` = 24-7 channel **32**. So `stream-N`, `watch.php?id=N`, `cast/stream-N.php` … all key off the same channel id.
* 326 `.schedule__event`: **310 on "Tuesday 10th Nov 2026"**, **16 on a stale "Tuesday 28th April 2026"** block that is `aria-expanded="false"`, sits in legacy `Soccer`/`Cricket` sections and has **zero** channel anchors (kept, `channels: []`).
* 44 `.schedule__catHeader`, **42 distinct today**: `Upcoming Events`, `TV Shows 📺`, `England - EFL Trophy ⚽`, `All Soccer Events ⚽`, `NBA Basketball 🏀`, `NHL Ice Hockey 🏒`, `Tennis 🎾 ATP - Singles: Stockholm (Sweden)`… Time = UK-GMT `HH:MM` string in `data-time`.
* 337 unique channel ids referenced; 2 absent from the directory (`5000` Netflix, `00` placeholder "Channel Not Listed #JustAsk"). Ids run to 5000. 101 events point at id `00`, whose `/stream/stream-00.php` is **404** — those rows get `stream_url: null`.
* → `events.json` = `{title, category, day, time, channels:[{id,name,slug}], channel_id, watch_url, stream_url}` (310 rows with channels, 16 without).

## 4. Alternate players — providers rotate per channel *and* per folder
`/watch.php?id=N` emits `button.player-btn[data-url]` for 7 folders; the iframe `src` differs by folder
and by id:

| id | `/cast/` P2 | `/plus/` P4 | `/casting/` P5 | `/player/` P6 |
|---|---|---|---|---|
| 61 | `tossequip.net/e/lavhlvnunx33l` | `out-3.welovetocare.shop/play.html#1/61` | `api.cdnlivetv.tv/…?name=bein+sports+mena+1&code=us` | `ksohls.ru/premiumtv/daddyhd.php?id=61` |
| 302 | `tossequip.net/e/pq1gwzp9y0h03` | `ehgembxe.cfd/mpmo2rq6-626` | `ksohls…?id=302` | `ksohls…?id=302` |
| 405 | `tossequip.net/e/acgheutl8kp7b` | `ehgembxe.cfd/a40czx8e-9307` | `cdnlivetv…?name=nfl+network&code=us&user=cdnlivetv&plan=free` | `wideiptv.top/daddy.php?stream=NFLNETWORK` |
| 891 | `tossequip.net/e/cd8o1d8a6rtzg` | `liveon5.zip/daddy.php?a=2679` | `ksohls…?id=891` | `ksohls…?id=891` |

`/cast/` **never** carries the numeric id — it is an 11–13 char opaque token, obtainable only by fetching
`/cast/stream-N.php`. `/hub/` and `/watch/` mirror `/stream/` (dembed.st).

### 4a. `tossequip.net` (/cast/) — **DIRECTLY PLAYABLE**, no Turnstile
`GET https://tossequip.net/e/lavhlvnunx33l` **without** Referer → **200** 797 B `<title>Not allowed</title>`.
**With `Referer: https://thedaddy.li/`** → **200** 150 708 B, `<title>stream 61</title>`, clappr +
swarmcloud P2P, `<script id="config">window._econfig='<148 592 b64 chars>'`.

Decoder, lifted verbatim from `/assets/stream.js?_v=0.0.26` (`_0x1b7ade`): `atob(s)` → split into 4 equal
chunks → drop the 4th character of each chunk → `atob` each → reorder by `[2,0,3,1]` → join → `atob` →
`JSON.parse`. Exact result:

```json
{"swarm_id":"xs_lavhlvnunx33l",
 "stream_url":"https://8z09jo.7odxv0l067ka.net:8443/hls/k5atkajfhkgk1.m3u8?s=GpD2WjlfDsCv8I0K9KxBUA&e=1794354407",
 "stream_url_nop2p":"<same>","p2p":true,"p2p_tracker":"wss://hlspatch.net:3000","swarmcloud":true,
 "swarmcloud_token":"NEWP1kbDR","domainlocked":false,"autoplay":true,"sandbox_block":true,
 "devtools_block":true,"hframes_inject_secs":5,...}
```
* `GET stream_url` → **200** 371 B `application/vnd.apple.mpegurl` — a **flat media playlist** (no master, no variants), `#EXT-X-MEDIA-SEQUENCE:17102`, segments `k5atkajfhkgk1-<n>.ts`. **No Referer required.**
* Segment `…/hls/k5atkajfhkgk1-895706640.ts?s=…&e=…` → **403** (555 B `nginx/1.24.0`) bare; **200, 2 067 248 B, `video/mp2t`** with `Referer: https://tossequip.net/`. Host must be tossequip.net (thedaddy.li / google.com / the CDN host itself → 403). Token `e=` expires ~6 h out.
* Generalises: `/e/pq1gwzp9y0h03` → `xs_pq1gwzp9y0h03` → `…/hls/k5aim9kfephk3.m3u8` 200/370 B; `/e/7i3s718z15a43` → `…/hls/o9mvou7h7jmct.m3u8` 200/379 B.

### 4b. `out-3.welovetocare.shop/play.html#1/61` (/plus/, id 61 only) — DEAD
A record → `8.8.8.8` (wildcard placeholder); TLS cert has no SAN for the host → curl error 60 before any
HTTP response. The `#1/61` fragment is never sent to a server. Id 302 on the same folder uses `ehgembxe.cfd`.

### 4c. `api.cdnlivetv.tv` (/casting/) — token-in-URL HLS, currently capped
* `GET …/api/v1/channels/player/daddylive/?name=nfl+network&code=us` → **401** `<html><body><h1>401 Unauthorized</h1></body></html>` (51 B) even with `Referer`/`Origin: thedaddy.li`. The site's own id-61 URL (`name=bein+sports+mena+1&code=us`) also 401s, then 404.
* Appending `&user=cdnlivetv&plan=free` → **200** `text/html` **11 403 B**, `<title>NFL Network HD SE</title>`, `@oplayer` + `hls.js` + `p2p-media-loader`, **no JSON**. Bad name → **404** `Channel not found` (17 B).
* The page assembles the playlist URL from base64 literals: `https://api.cdnlivetv.tv/secure/api/v1/6add40ae2d4a99e07363c372/playlist.m3u8?token=<b64>`, token decodes to `6add40ae…:1794346929408:api.cdnlivetv.tv:d53ac4a796885c55.<40-byte hmac>` (`channel-id : expiry-ms : host : nonce.hmac`).
* That URL → **503** body `provider-cap` (12 B) on 4/4 attempts across 4 channels (nfl network, espn, cnn, sky sports 1); one **502** `read ECONNRESET` (15 B). Headers `ratelimit-policy: 100;w=60`, `ratelimit-limit: 100`, `access-control-allow-origin: *`. Fetchable by design, **serves no playlist now**.

### 4d. `www.ksohls.ru/premiumtv/daddyhd.php?id=61` (/player/) — DEAD
`dig` → **NXDOMAIN** for `www.ksohls.ru` and `ksohls.ru`; curl error 6. This is what `/player/` and
`/casting/` hand out most often, so P5/P6 are largely broken.

### 4e. Other providers in the rotation
* `wideiptv.top/daddy.php?stream=NFLNETWORK` (id 405) → **200** 834 B wrapping `<iframe src="/player/NFLNETWORK">`. `GET /player/NFLNETWORK` **with `Referer: https://wideiptv.top/`** → **200** 10 477 B with inline `https://cdn.hdm1.net/NFLNETWORK/index.m3u8?token=<b64>.<hex>`; token b64 = `NFLNETWORK|no_check_ip|<unix exp>`. **Full chain proven 17:50 UTC:** master **200** 299 B (`AVERAGE-BANDWIDTH=4810000,1920x1080`), variant `tracks-v1a1/mono.m3u8?token=…` **200** 767 B, segment `2026/11/10/17/50/31-06323.ts?token=…` **200, 5 558 784 B `video/MP2T`**. Caveat: after ~8 MB the same flow returns **403** 1147 B ("Streamer protection system doesn't allow you to watch this content") with fresh tokens → per-IP/quota shaping. Intermittent.
* `ehgembxe.cfd/<slug>` (/plus/) → **302** to `/play/<JWE alg=dir enc=A256GCM>` → **200** 313 341 B, JW Player 8, `/disable-devtool.js`, fully obfuscated; **no `.m3u8`, no `source`/`file` key**. JS-only, in-page token mint → m3u8 **UNKNOWN** without executing the bundle.
* `matchora.to/embed/channel/45439` (/casting/) → **200** 146 829 B, `hls.js` + `challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` — same Turnstile gate as dembed.st. Not attempted.
* `liveon5.zip/daddy.php?a=2679` (/plus/) → **404** 58 296 B (WordPress-style). `tv-bu1.blogspot.com/p/e1.html?id=51a` (/player/) → Blogspot, not evaluated.

## 5. Site-wide
* `GET /robots.txt` → **200** 75 B: `User-agent: *` / `Allow: /` / `Sitemap: https://daddyhd.com/sitemap.xml` (cross-domain mirror).
* `GET /sitemap.xml` → **200** 90 458 B `text/xml`, **545 `<url>`**, all on **`dlhd.dad`** (not thedaddy.li): 506 `/watch.php`, 34 `/index.php?cat=…`, plus `/`, `/24-7-channels.php`, `/contact.php`, `/webmasters.php`, `/schedule/schedule-generated.php`. Every `lastmod` is `2025-09-15` → stale.
* **Front-end JSON endpoint:** `GET /schedule-api.php?source=<src>` (`application/json`, no auth). Found via `div.schedule--compact.js-remote-schedule[data-endpoint]` + `window.loadRemoteSchedule()`, which runs `fetch(endpoint,{credentials:'same-origin',headers:{Accept:'application/json'}})`. Seven sources: `extra`, `extra_backup`, `extra_plus`, `extra_ppv`, `extra_sd`, `extra_sports`, `extra_topembed`. Contract `{"success":true,"html":"<p>No extra schedule available.</p>"}` (**200**, 64 B; *all 7 were empty at 17:40 UTC*, so the populated shape is UNKNOWN but is server-rendered `.schedule__event` HTML). Bad/missing source → **400** `{"success":false,"error":"Invalid schedule source."}` (54 B).
* `GET /schedule/schedule-generated.php` → **403** 116 B `Schedule API Available for allowed Domain only! <br>Contact US! for Schedule API Email : daddylivehd@proton.me` — unchanged with `Referer`/`Origin: thedaddy.li`, `X-Requested-With`, `?date=`. Domain allowlist.
* Non-existent: `/channels-api.php`, `/events-api.php`, `/api/channels.php` → **404** 2 732 B. `/channels.php?format=json` → **200** HTML. No other `fetch()`/XHR endpoint exists in any inline script.

## Summary
**Best directly-playable provider = `tossequip.net` (/cast/, player 2).** No Turnstile, no JS runtime:
`GET /cast/stream-N.php` → `src` → `GET https://tossequip.net/e/<token>` with `Referer: https://thedaddy.li/`
→ decode `_econfig` (4-way split, drop 4th char, order `[2,0,3,1]`, `atob`×3, `JSON.parse`) → `stream_url`
is a flat media playlist (200/371 B) → segments need `Referer: https://tossequip.net/`
(200, 2.07 MB `video/mp2t`). Runner-up: `wideiptv.top` (/player/, id 405 only) which inlines a plain
master→variant→segment chain, proven once at 5.56 MB but now IP-throttled.

**24-7 catalogue formula** (`/24-7-channels.php`):
`/<a class="card"\s*href="\/watch\.php\?id=(\d+)"\s*data-title="([^"]*)"\s*data-first="([^"]*)">\s*<div class="card__title">(.*?)<\/div>/`
→ `{id:int, name:html_unescape(strip_tags(title)), group:data-first}`. 900 cards / 899 unique (811 duped).

**Event formula** (`/`, or `/index.php?cat=<urlencoded>`): walk the document in order, tracking the last
`.schedule__dayTitle` and last `.schedule__catHeader > .card__meta`; per `.schedule__event` take
`.schedule__time[data-time]`, `.schedule__eventTitle` text, and every `.schedule__channels
a[href^="/watch.php?id="]` (`title`=name, `data-ch`=slug); `stream_url = /stream/stream-<id>.php`.
326 events (310 live today, 16 stale).
