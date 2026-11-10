# dlhd-bridge

A single small Docker container that exposes DLHD (DaddyLiveHD, `thedaddy.li`) as a
Jellyfin Live TV source: one **M3U** playlist, one **XMLTV** guide, and an **HLS proxy**
so Jellyfin never needs a browser, a `Referer` header, or a Cloudflare token.

The pipeline is: scrape the public catalogue from `thedaddy.li` (24/7 channels +
event schedule) → resolve a channel on demand through the `tossequip.net` player
(the one provider that needs no Cloudflare Turnstile) → rewrite and proxy its HLS
playlist/segments → serve `/playlist.m3u` and `/xmltv.xml` on a single origin.
Nothing is stored on disk; resolution is lazy and TTL-cached.

> ## ⚠️ Legal notice
>
> This project bridges **third-party public web streams** and is intended for
> **personal use only**. You are solely responsible for complying with the laws of
> your jurisdiction and with the upstream services' terms of service. Do **not**
> expose this container to the public internet, and do **not** redistribute the
> streams or the generated playlists. The authors provide no warranty and accept
> no liability for misuse.

> ## Vibe coded
>
> This project was vibe coded and no review of code has been done. Use at your
> own risk.

---

## Architecture

```
 ┌──────────────┐      /playlist.m3u, /xmltv.xml       ┌──────────────────────────────┐
 │   Jellyfin   │ ────────────────────────────────────▶ │        dlhd-bridge           │
 │  Live TV +   │                                       │  Docker · node:22-alpine     │
 │  TV Guide    │ ◀──────────────────────────────────── │  listens on :8080            │
 └──────────────┘   /stream/:id.m3u8, /seg/:id/…        │                              │
        ▲              (rewritten HLS)                  │  catalogue cache (10 min)    │
        │                                               │  resolution cache (10 min)   │
        │                                               └───────────┬──────────────────┘
        │                                                           │
        │                                                           │ scrape (HTTP)
        │                                                           ▼
        │                                               ┌──────────────────────────────┐
        │                                               │ thedaddy.li                  │
        │                                               │  /24-7-channels.php          │
        │                                               │  /  (event schedule)         │
        │                                               │  /cast/stream-<id>.php       │
        │                                               └───────────┬──────────────────┘
        │                                                           │ iframe → token page
        │                                                           ▼
        │                                               ┌──────────────────────────────┐
        │           segments proxied with Referer       │ tossequip.net /e/<token>     │
        └───────────────────────────────────────────────│  → stream_url (HLS)          │
                                                        │ provider CDN → .m3u8 + .ts   │
                                                        └──────────────────────────────┘
```

Everything Jellyfin needs is on one origin. Upstream URLs are never exposed to the
client: playlist URIs are rewritten to `/seg/<id>/<base64url>`, and only
allowlisted hosts are ever fetched.

## Quick start

```sh
docker compose up -d --build
./scripts/smoke.sh            # verifies health, playlist, guide and one live segment
```

Open <http://127.0.0.1:8080/> for a status page, or
<http://127.0.0.1:8080/healthz> for JSON:

```json
{ "ok": true, "channels": 899, "events": 329, "resolved": 0, "uptime": 12 }
```

`ok:true` means the first catalogue scrape has completed, not merely that the
process is listening. The first scrape usually takes 2–5 seconds; the container
healthcheck only requires the HTTP server to answer.

Without Compose:

```sh
docker build -t dlhd-bridge:latest .
docker run -d --rm --name dlhd-bridge -p 8080:8080 --read-only --tmpfs /tmp dlhd-bridge:latest
```

## Jellyfin setup

1. **Dashboard → Live TV → Tuner Devices → Add Tuner → M3U Tuner**
   - File or URL: `http://<host>:8080/playlist.m3u`
   - Tuner count: 1–3 (each concurrent viewer holds its own upstream segment pulls)
   - Leave "Use Schedules Direct" off.
2. **Dashboard → Live TV → TV Guide Data Providers → Add Provider → XMLTV**
   - File or URL: `http://<host>:8080/xmltv.xml`
   - Enable "Download guide data" and set a refresh interval (e.g. every 1–6 hours).
3. Run a full guide refresh once: **Dashboard → Scheduled Tasks → Refresh Guide**.

Notes:

- Use the container's LAN address (`http://192.168.x.y:8080/...`), not `localhost`,
  when Jellyfin runs on another machine. The playlist derives absolute stream URLs
  from the `Host` header, so no extra configuration is needed. If you are behind a
  reverse proxy, either pass the correct `Host`/`X-Forwarded-Proto` headers or set
  `BASE_URL`.
- The Jellyfin guide refresh interval must be **greater than or equal to**
  `CATALOG_REFRESH_MIN`, otherwise the bridge refreshes its catalogue faster than
  Jellyfin reads it and schedule changes are never picked up. Jellyfin also
  refreshes the tuner playlist on the guide refresh, so 30–60 minutes is a good
  starting point; the default catalogue refresh is 10 minutes.
- Channel ids are stable (`tvg-id="dlhd-<id>"` for 24/7 channels,
  `tvg-id="dlhd-ev-<id>"` for events), so Jellyfin keeps its channel mappings
  across restarts.

## Endpoints

| Route              | Method    | Description                                                                                      |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------ |
| `/`                | GET, HEAD | Small HTML status page: counts, uptime, catalogue age, endpoint list.                            |
| `/healthz`         | GET, HEAD | JSON `{ok, channels, events, resolved, uptime}`. `ok` is true after the first successful scrape. |
| `/playlist.m3u`    | GET, HEAD | M3U playlist. Alias: `/playlist.m3u8`. ETag + `max-age=30`.                                      |
| `/xmltv.xml`       | GET, HEAD | XMLTV 0.1 guide. Alias: `/epg.xml`. ETag + `max-age=300`.                                        |
| `/stream/:id.m3u8` | GET       | Resolves and rewrites one channel's HLS playlist.                                                |
| `/seg/:id/:token`  | GET       | Segment/init/key passthrough; accepts `Range` and returns 200/206.                               |

Query parameters for `/playlist.m3u`:

| Parameter        | Values                              | Default                  | Meaning                                                                                                                                                                       |
| ---------------- | ----------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | `all`, `channels`, `events`, `live` | `all`                    | `channels` = 24/7 only; `events` = schedule only; `live` = running now or starting within `window`. Scheduled events that ended more than 6h ago are skipped as dead streams. |
| `window`         | 0–10080 (minutes)                   | `EVENT_WINDOW_MIN` (120) | Look-ahead used by `mode=live`.                                                                                                                                               |
| `include_future` | `0`/`1`                             | `0`                      | With `mode=live`, also include events that start after now.                                                                                                                   |
| `limit`          | 1–100000                            | unlimited                | Truncate the generated list after sorting (channels first, then events by start time).                                                                                        |

Examples:

```sh
curl 'http://127.0.0.1:8080/playlist.m3u?mode=live&window=240&include_future=1'
curl 'http://127.0.0.1:8080/playlist.m3u?mode=channels&limit=50'
```

Malformed parameters return `400 {"error":"bad_request","message":"…"}`. Unknown
paths return a JSON 404; wrong methods return 405 with an `Allow` header.

## Configuration

All settings are environment variables. Invalid values fail fast at startup with a
descriptive error.

| Variable              | Default               | Meaning                                                                                                                                                                                          |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                | `8080`                | HTTP listen port inside the container.                                                                                                                                                           |
| `BASE_URL`            | _(empty)_             | Public origin used to build absolute links in the playlist and `x-tvg-url`, e.g. `http://192.168.1.10:8080`. When empty, the request `Host` header (sanitised) and `X-Forwarded-Proto` are used. |
| `CATALOG_REFRESH_MIN` | `10`                  | Minutes between catalogue scrapes (1–1440). Failed refreshes keep the previous snapshot.                                                                                                         |
| `EVENT_WINDOW_MIN`    | `120`                 | Default look-ahead window in minutes for `mode=live` (0–10080).                                                                                                                                  |
| `RESOLVE_TTL_SEC`     | `600`                 | Seconds a resolved upstream `stream_url` is reused before resolving again (1–86400).                                                                                                             |
| `UPSTREAM_TIMEOUT_MS` | `15000`               | Per-request upstream timeout in milliseconds (100–120000).                                                                                                                                       |
| `USER_AGENT`          | Chrome 133 desktop UA | User-Agent sent to the site and providers. Override only if the upstream starts rejecting the default.                                                                                           |
| `LOG_LEVEL`           | `info`                | `debug`, `info`, `warn` or `error`. Query strings are always redacted from logs.                                                                                                                 |
| `TZ`                  | `UTC`                 | Container timezone. Generated XMLTV times are always UTC; `TZ` does not change them.                                                                                                             |

Docker Compose reads the same names from `.env` (see `docker-compose.yml`).

## How it works

### Catalogues

The bridge scrapes two public pages into memory on a timer:

- **24/7 channels** from `/24-7-channels.php` — about **899 unique channels**
  (900 cards; one id is duplicated upstream). Grouped only alphabetically, which
  becomes the `24/7 | <letter>` group in the playlist.
- **Scheduled events** from the homepage — about **329 event blocks** per day.
  Roughly **210** of them reference a real channel id; rows that only point at the
  site's `id=00` placeholder are dropped because they cannot play. Events that
  ended more than 6 hours ago are dropped too, so the event section of the
  playlist tracks what is actually still watchable.

Playlist entries are generated **only** from this snapshot. No stream is resolved
while building `/playlist.m3u`; doing that for ~900 ids would be slow and abusive.
Resolution happens lazily on the first `/stream/:id.m3u8` request and is cached.

### Providers: why `tossequip.net` and not `dembed.st`

`thedaddy.li` rotates several player folders per channel. The bridge uses `/cast/`
(player 2), which fronts **`tossequip.net`**:

1. `GET /cast/stream-<id>.php` → an `<iframe src="https://tossequip.net/e/<token>">`.
2. `GET https://tossequip.net/e/<token>` with `Referer: https://thedaddy.li/`.
3. The page embeds `window._econfig` as base64; decoding it (split into 4 chunks,
   drop one character from each, reorder, base64-decode again, JSON-parse) yields
   `stream_url` — a plain HLS media playlist.
4. Playlist and segments are fetched with `Referer: https://tossequip.net/`.

**No browser is required.** The token page is ordinary HTML and the stream URL is
signed, not browser-bound.

The `dembed.st` / `edge.wedd48c.top` player (`/stream/`, `/watch/`, `/hub/`) is
deliberately **not** used. Its edge returns `403 token required` for the manifest,
and minting that token requires a valid **Cloudflare Turnstile** solve:
`daddy.min.js` renders Turnstile into the page and refuses to send the redeem POST
without a `cf-turnstile-response`. Every redeem variant without a real token —
missing, empty, dummy, correctly HMAC-signed — returns the same
`403 {"ticket":""}` (verified, see `PROTOCOL.md`). Headless browsers also fail the
challenge, so bypassing it would mean defeating a CAPTCHA, which this project
explicitly does not do.

A best-effort fallback (`/player/` → `wideiptv.top`) is tried when `/cast/` fails.

Not every id lives on `tossequip.net`: the site spreads its schedule across
several players (`vertex.st`, `embedindia.st`, `wikisport.info`,
`realembeds.xyz`, …). When `/cast/stream-<id>.php` embeds one of those, the bridge
reports `provider-unsupported`, keeps the id out of the playlist for an hour and
answers `/stream/<id>.m3u8` with an immediate 502 instead of hammering the
upstream. Session events that only exist on those players therefore disappear
from the list rather than showing as dead entries.

### Proxy behaviour

- `/stream/:id.m3u8` fetches the upstream playlist, rewrites every URI line and
  every `URI="…"` attribute (`EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-MEDIA`) to
  `/seg/<id>/<base64url(absolute-url)><ext>`, and leaves all other tags untouched.
  The real media extension (`.ts`, `.m4s`, `.mp4`, …) is preserved because
  ffmpeg's HLS demuxer refuses to fetch segment URLs without one.
- `/seg/:id/<token>` decodes the token, requires `https`, rejects credentials and
  enforces a host allowlist (`tossequip.net`, `wideiptv.top`, plus any host seen in
  a successful resolution). Segments are streamed through with `pipeline` — never
  buffered whole — and `Range` is passed through.
- An upstream 403/404 on a playlist or segment triggers **one** re-resolve, then a
  502/403. Resolutions are single-flight per id, so a burst of clients causes one
  upstream fetch.

### Guide

`/xmltv.xml` emits one `<channel>` per catalogue entry with ids matching the
playlist `tvg-id`. 24/7 channels get four 6-hour `<programme>` blocks covering the
next 24 hours; events get one programme from their scheduled start time. Every
channel referenced by an event also gets a channel entry, even if it has no 24/7
mapping. The generator caps output at 5000 programmes (adds header
`X-Programmes-Truncated: 1` if hit) and skips events that ended more than 6 hours
ago.

## Reliability and limitations

- **Provider domains rotate.** `tossequip.net`, its CDN hostnames, and the site's
  folder layout change without notice. The code is tolerant of path changes but a
  new provider protocol may need a code update.
- **Resolution is lazy and TTL-cached.** A stream can fail once when its upstream
  token expires; the bridge re-resolves on 403/404. `RESOLVE_TTL_SEC` controls the
  normal refresh cadence.
- **Event durations are approximate.** The public schedule publishes a start time
  but no end time, so every event defaults to **3 hours**.
- **No DRM handling.** Only clear HLS is bridged; encrypted/DRM streams will not
  play.
- **Upstream rate limits and geo-blocks** apply. Rapid zapping across many channels
  can trigger provider throttling (the fallback provider can return 403 after a few
  megabytes), and some channels are region-restricted.
- **Not a re-encoder.** The bridge is a pure passthrough: bitrate, codecs and
  segment sizes are whatever the upstream serves. Transcoding, if any, happens in
  Jellyfin.
- **One process, one port, no persistence.** Restarting the container loses the
  caches and the next scrape rebuilds everything. Nothing is written to disk, so the
  container can run with `--read-only`.
- **Catalogue quality is upstream's.** Duplicate cards, placeholder ids (`00`) and
  stale schedule days are filtered best-effort but can still produce channels that
  resolve to 502.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                   | Fix                                                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/playlist.m3u` is empty or `/healthz` says `"ok":false` | First scrape failed (upstream down, DNS, egress blocked)                                       | `docker logs dlhd-bridge`; check `/healthz` for `errors`; verify the container can reach `thedaddy.li`; the next refresh retries automatically.                                    |
| Playlist has channels but Jellyfin shows none            | Wrong URL/host, or Jellyfin cached an empty first fetch                                        | Open the M3U URL from the Jellyfin host; use the LAN IP, not `localhost`; refresh the tuner.                                                                                       |
| `502` on a specific channel                              | `provider-unsupported` (the id lives on a player we cannot script), provider rotation, or rate limiting | Check `docker logs dlhd-bridge` for the reason code. `provider-unsupported` is expected for some schedule events and is retried after an hour. Retries inside the backoff window are served from cache, so one warning per id — not per request. |
| `FFmpeg exited with code 183`, `ffprobe failed - streams and format are both null` | Jellyfin could not fetch the HLS segments — almost always an old image whose `/seg/` URLs had no media extension, or hardware transcoding that cannot open `/dev/dri` | Upgrade to the current image (`docker compose up -d --build`); verify from the Jellyfin host with `/usr/lib/jellyfin-ffmpeg/ffprobe <bridge>/stream/61.m3u8`. If that works but playback fails, it is a Jellyfin QSV/VAAPI problem, not the bridge. |
| Channels play but the guide is empty                     | XMLTV URL wrong, guide refresh not run, or refresh interval shorter than `CATALOG_REFRESH_MIN` | Fetch `/xmltv.xml` and confirm `<programme>` entries; add the XMLTV provider; run **Refresh Guide**; set the interval ≥ catalogue refresh.                                         |
| Guide shows wrong times                                  | Jellyfin timezone vs. UK schedule                                                              | Times are parsed as UTC; set the correct timezone in Jellyfin → Dashboard → General.                                                                                               |
| Container is `unhealthy`                                 | Healthcheck cannot reach the port, or startup is slow                                          | Check `docker inspect --format '{{json .State.Health}}' dlhd-bridge`; if you changed `PORT`, keep the container port mapping consistent.                                           |
| Works, then every stream 403s after a while              | Upstream token/host rotation or IP throttle                                                    | Restart the container to drop caches, lower concurrent viewers, or raise `RESOLVE_TTL_SEC` only if tokens are long-lived. Open an issue if `/cast/` itself changed.                |
| High CPU / memory                                        | Many concurrent segments or a very large catalogue scrape                                      | Lower the Jellyfin tuner count; the idle footprint is small (single Node process, in-memory catalogue).                                                                            |

## Development

```sh
npm test              # 16 tests; live tests hit the real site (skip with OFFLINE=1)
npm run test:offline  # pure unit tests only
./scripts/dev.sh      # node --watch src/index.js with LOG_LEVEL=debug
./scripts/smoke.sh    # end-to-end checks against BASE_URL (default :8080)
```

`scripts/smoke.sh` accepts `BASE_URL` and `SMOKE_TIMEOUT` (seconds, default 60) and
uses only `curl` plus POSIX text tools.

## Legal notice

This software bridges third-party public web streams for **personal use only**. It
does not host, store, re-encode or redistribute any content. You are responsible for
ensuring your use complies with local law and with the upstream services' terms of
service. Do not expose the container publicly and do not redistribute the streams or
generated playlists. Use at your own risk; no warranty is provided.
