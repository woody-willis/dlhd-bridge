# ARCHITECTURE — DLHD → Jellyfin bridge

Read `NOTES.md`, `PROTOCOL.md`, `ENDPOINTS.md` first. This file is the contract all
code must follow. Do not change module boundaries or export names without updating
this file.

## Product
One small Docker container that:
1. scrapes thedaddy.li for all 24/7 channels + the event schedule,
2. resolves each item to a playable HLS stream via the **tossequip.net** provider
   (`/cast/stream-<id>.php`) — the only provider that needs no Turnstile,
3. serves a single M3U playlist + XMLTV guide for Jellyfin, and
4. proxies every playlist/segment request so Jellyfin never needs the upstream
   Referer/Origin or a browser.

Everything Jellyfin needs is on one origin: `http://<host>:8080`.

## Runtime
- Node.js 22 (ESM, `"type": "module"`), zero runtime deps except what is vendored in
  `package.json` (prefer `undici` bundled in Node 22 / global fetch; no express —
  use `node:http`).
- Single process, one port (default 8080).
- No headless browser, no Turnstile, no external services.

## Module layout

```
src/
  config.js          env parsing, constants
  log.js             tiny levelled logger
  http.js            fetch wrapper: UA, timeout, retry, Referer injection
  catalog/
    index.js         exports getChannels(), getEvents(), startCatalogRefresh()
    scrape.js        HTML extraction (regex-based, tolerant)
  providers/
    index.js         exports resolve(id) -> {url, headers, ttlMs, provider}
    tossequip.js     cast/tossequip resolver (primary)
    fallback.js      best-effort secondary resolvers (may return null)
  server/
    index.js         http server, routing, graceful shutdown
    playlist.js      M3U generation
    xmltv.js         XMLTV generation
    hls.js           playlist rewriting + segment proxying
    cache.js         TTL cache with single-flight
test/
  *.mjs              node:test scripts that hit the live site (skipped when OFFLINE=1)
Dockerfile
docker-compose.yml
README.md
```

## Data shapes (exact)

```js
// channel
{ id: 61, name: "beIN Sports MENA English 1", group: "B" }

// event
{ id: 337, title: "Team A vs Team B", category: "All Soccer ⚽",
  startMs: 1794312000000, endMs: 1794319200000,
  channelIds: [32, 33], channelNames: ["tennis stream", "extra stream"] }

// resolve() result
{ url: "https://…/index.m3u8", headers: { Referer: "https://tossequip.net/" },
  ttlMs: 600000, provider: "tossequip" }
```

`resolve(id)` must:
- fetch `https://thedaddy.li/cast/stream-<id>.php` (Referer `https://thedaddy.li/`),
  extract the `<iframe src>` → `https://tossequip.net/e/<token>`,
- fetch that page with `Referer: https://thedaddy.li/`,
- decode `window._econfig` → JSON → `stream_url`,
- return that URL with `Referer: https://tossequip.net/` in headers.
- throw a `ResolveError` with a `.reason` short code on failure.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /playlist.m3u` | full playlist (default `mode=all`) |
| `GET /playlist.m3u?mode=channels` | 24/7 channels only |
| `GET /playlist.m3u?mode=events` | scheduled events only |
| `GET /playlist.m3u?mode=live` | events live now (or starting within `window` min) |

Events whose `endMs` is more than 6h in the past are omitted from every mode
(their streams are dead), and event entries with no playable channel id — the
site's `id=0` placeholder links — are skipped entirely.
| `GET /xmltv.xml` | XMLTV guide |
| `GET /stream/:id.m3u8` | master/media playlist, rewritten |
| `GET /seg/:id/:file` | segment/init/key passthrough |
| `GET /healthz` | `{ok, channels, events, resolved, uptime}` |
| `GET /` | small HTML status page listing endpoints + counts |

Query params for `/playlist.m3u`: `mode`, `window` (minutes, default 120),
`include_future` (0/1), `limit`.

### Playlist entry format
```
#EXTINF:-1 tvg-id="dlhd-61" tvg-name="beIN Sports MENA English 1" tvg-logo="" group-title="24/7 | B",beIN Sports MENA English 1
http://<host>:8080/stream/61.m3u8
```
Events use `tvg-id="dlhd-ev-337"`, `group-title="Live | All Soccer ⚽"`, and the event
title as the display name. Include `#EXT-X-SERIES`? No. Keep it M3U8-compatible
(Jellyfin also accepts .m3u).

The playlist must be generated from the **catalogue cache**, never by resolving
streams inline (resolving 900 ids per request would be abusive and slow).
`/stream/:id.m3u8` resolves lazily on demand and caches.

### Proxy rules (`hls.js`)
- `GET /stream/:id.m3u8`: resolve id (cached), fetch upstream playlist with the
  provider headers, rewrite:
  - every URI line → `/seg/<id>/<base64url(absolute original URL)>`
  - `#EXT-X-KEY:URI="…"`, `#EXT-X-MAP:URI="…"`, `#EXT-X-MEDIA:URI="…"` →
    same rewrite, and `#EXT-X-STREAM-INF` variant lines likewise.
  - keep `#EXT-X-…` tags verbatim otherwise. Rewrite `#EXT-X-PLAYLIST-TYPE`/
    `#EXT-X-ENDLIST` untouched.
- `GET /seg/:id/<b64url><ext>`: decode, validate the host is on the provider
  allowlist, stream the upstream response body through with the provider
  headers. Support `Range` passthrough. Do not buffer whole segments in memory.
  `<ext>` is the original media extension (`.ts`, `.m4s`, `.mp4`, …) because
  ffmpeg's HLS demuxer rejects segment URLs without a recognised extension; the
  handler strips it before base64url-decoding (base64url never contains a dot).
- On upstream 403/404 for a playlist: re-resolve once, then 502.
- Never expose upstream URLs in the status page.

## Failure handling

`providers/index.js` keeps a negative cache so a player that repeatedly requests a
dead id cannot generate upstream load or log spam:

- `provider-unsupported` (the `/cast/` page embeds a player we cannot script,
  e.g. `vertex.st`, `embedindia.st`) — cached 60 min, fallback skipped, and the id
  is filtered out of `/playlist.m3u` via `unplayableIds()` until expiry.
- any other failure — exponential backoff 30 s → 10 min.
- retries inside the window throw a `ResolveError` with `.cachedFailure = true`;
  `hls.js` logs those at debug level and returns `502` + `Retry-After`.

## Caching & refresh
- Catalogue: refresh every `CATALOG_REFRESH_MIN` (default 10) with stale-on-error.
- Resolved stream: TTL from `resolve().ttlMs`, default 10 min, single-flight per id.
- Playlist response: `Cache-Control: public, max-age=30`.
- XMLTV: `Cache-Control: public, max-age=300`.

## XMLTV
- One `<channel>` per catalogue entry (channels + event items), ids matching the
  playlist `tvg-id`.
- For 24/7 channels: emit one `<programme>` per 6h block covering now..+24h with the
  channel name as `<title>` (`<desc>` says "24/7 channel").
- For events: one `<programme start=… stop=…>` using the schedule's start/end,
  `<title>` = event title, `<category>` = category.
- Times in `YYYYMMDDHHMMSS +0000`. XML-escape everything.

## Env
```
PORT=8080
BASE_URL=            # optional; used to build absolute playlist URLs (default: from request Host)
CATALOG_REFRESH_MIN=10
EVENT_WINDOW_MIN=120
RESOLVE_TTL_SEC=600
UPSTREAM_TIMEOUT_MS=15000
USER_AGENT=Mozilla/5.0 (…Chrome/131…)
TZ=UTC
LOG_LEVEL=info
```

## Non-goals / rules
- No Turnstile bypassing, no captcha solvers, no account credentials.
- No scraping of ad/analytics domains.
- Keep upstream request volume low: single-flight, TTL caching, no per-request
  re-resolution of the whole catalogue.
- Container must run as non-root, expose only 8080, and have a HEALTHCHECK.

## Legal notice (must appear in README)
This bridges third-party public web streams for personal use. The operator is
responsible for compliance with local law and the upstream services' terms. Do not
redistribute or run it publicly.
