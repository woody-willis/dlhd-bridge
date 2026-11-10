# DLHD / thedaddy.li — REA findings ledger

Working dir for raw artifacts: `/private/var/folders/59/9hhfkkr14ndb1s13k3vmgn880000gn/T/opencode/`

## Target
`https://thedaddy.li/` (DaddyLiveHD / DLHD). nginx, Cloudflare-fronted. Site is server-rendered PHP.

## Site surface (observed 2026-11-10, via curl + REA browser scenario)
- `/` schedule page. Event cards link to `/stream/stream-<N>.php`. Channel list links to `/watch.php?id=<N>`.
  - Channel anchors carry `data-ch="<slug>"` and `title="<name>"`.
- `/watch.php?id=<N>` — 24/7 channel page. Embeds `<iframe id="playerFrame" src="https://thedaddy.li/stream/stream-<N>.php">`,
  plus 7 "player" buttons with alternate embed URLs:
  1. `/stream/stream-<N>.php`
  2. `/cast/stream-<N>.php`
  3. `/watch/stream-<N>.php`
  4. `/plus/stream-<N>.php`
  5. `/casting/stream-<N>.php`
  6. `/player/stream-<N>.php`
  7. `/hub/stream-<N>.php`
- `/24-7-channels.php` — full 24/7 channel directory.
- `/api.php` — linked in nav ("API"); not yet analysed.
- `/webmasters.php`, `/contact.php`.

Observed iframe targets per player (id=61):
1. `/stream/` → `https://dembed.st/premiumtv/daddy.php?id=61`
2. `/cast/`  → `https://tossequip.net/e/lavhlvnunx33l`
3. `/watch/` → `https://dembed.st/premiumtv/daddy.php?id=61`
4. `/plus/`  → `https://out-3.welovetocare.shop/play.html#1/61`
5. `/casting/` → `https://api.cdnlivetv.tv/api/v1/channels/player/daddylive/?name=bein+sports+mena+1&code=us`
6. `/player/` → `https://www.ksohls.ru/premiumtv/daddyhd.php?id=61`
7. `/hub/`   → `https://dembed.st/premiumtv/daddy.php?id=61`

## Primary provider: dembed.st (REA evidence ev_11c6d01a..., cap1/cap2/cap3)
`GET https://dembed.st/premiumtv/daddy.php?id=<N>` returns 403 body "This player only works when embedded."
unless Referer is a thedaddy.li page. With correct referer it returns 200 and embeds:

```html
<script>
const SRC   = "https://edge.wedd48c.top/premium<N>/index.m3u8";
const CFG   = {... "p2p":true ...};
const CHANNEL = "premium<N>";
const EDGE  = "https://edge.wedd48c.top";
const MARK  = "";
const CHAL  = {"n":"<32 hex>","e":<unix expiry>,"m":"<32 hex>"};
const TSITE = "0x4AAAAAAF7J_aqgDLdsENU";   // Cloudflare Turnstile site key
</script>
<script src="daddy.min.js?v=<ts>"></script>
```
Also loads `/premiumtv/KB5zFt7A.js` (JW Player 8.51.13 lib via content.jwplatform.com) and `/premiumtv/p2p-engine.min.js`.

### Edge protection (observed, cap3 seq 440-446)
`GET https://edge.wedd48c.top/premium61/index.m3u8?_=<ms>` →
- Referer: `https://dembed.st/`, Origin: `https://dembed.st`
- **403, body 15 bytes: `token required`**

So the plain `SRC` is NOT directly fetchable. A token is minted client-side and appended as a query param.

### Token protocol (static, partially deobfuscated `dm.deob.js` / `pretty.js`)
Obfuscator.io string-array obfuscation; function names are plain. Recovered logic in `pretty.js`:

1. `fetchTurnstileToken()` — renders Cloudflare Turnstile (`TSITE`, action string from obfuscated table) into `#ts`,
   resolves the `cf-turnstile-response` token, 120s timeout.
2. `fetchPageTicket()` — requires `CHAL`:
   - `crypto.subtle.importKey/HMAC` with key = `proofKeyBytes()` (20-byte hex string split into Uint8Array),
     message = `CHANNEL + '|' + CHAL.n + '|' + CHAL.e`, output `b64urlFromBuf(...)` → `p`
   - `fetch(location.pathname + location.search, { method: POST, credentials: ...,
      body: URLSearchParams{ redeem:'1', n: CHAL.n, e: CHAL.e, m: CHAL.m, p, 'cf-turnstile-response': token } })`
   - response JSON → `issuedTicket` (field name obfuscated, looked up as `_0x10630b('[4l1',-0x1ba)`)
3. `fetchPlaylistToken()` — `GET EDGE + "/<obfuscated path>?channel=" + CHANNEL + "&t=" + ticket + "&_=" + Date.now()`
   → JSON `{ token, ttl, k? }`; stored in `playToken`, `rememberPlayKey(...)`.
4. Playlist URL = `cleanPlaylistUrl(SRC)` + (`t=` + token) + `&_=` + Date.now().

TODO: exact literal strings for (a) the edge token path/params, (b) the ticket JSON field names,
(c) the HMAC hash/action names, (d) `proofKeyBytes()` constant. The deobfuscator resolved 849/1574
decoder call sites; remaining calls are nested wrappers.

## Useful local artifacts
- `dembed.html` — embed page (contains SRC/EDGE/CHAL/TSITE)
- `dm.js` — obfuscated daddy.min.js (135 KB); `pretty.js` — beautified partial deob
- `deob.js` — my string-array deobfuscator (Node; resolves 241 decoder wrappers)
- `watch61.html`, `p_stream.html`, `p_cast.html`, `p_plus.html`, `p_casting.html`,
  `p_player.html`, `p_hub.html`, `p_watch.html`
- `cap1.json`, `cap2.json`, `cap3.json` — REA `capture-browser-scenario` evidence (REA CLI fallback;
  MCP server is currently not connected in this session)

## Constraints
- REA MCP tools fail with "REA could not start"; use the CLI:
  `npx -y rea-agents@6.8.0 capture-browser-scenario <json>` (same provider/evidence format).
- Headless Chrome fails Cloudflare Turnstile, so the browser path yields no token.
