# DLHD / dembed.st — recovered token protocol

Deobfuscated from `daddy.min.js` (`https://dembed.st/premiumtv/daddy.js`). Toolchain: `deob2.js` →
`dm.deob2.js` → `dm.pretty2.js`; it replays the obfuscator.io array rotation (`}(a0_0x13c0,0xddfd8)`),
installs all 240 thin decoder wrappers, then iterates to a fixed point (1 776 replacements; **0**
literal-argument decoder call sites left). All code below is verbatim from `dm.pretty2.js`
(`"resolv"+'e'` style splits are the obfuscator's own, already decoded).

---

## 1. Protocol, client → server

```
GET  https://dembed.st/premiumtv/daddy.php?id=<N>
     Referer: https://thedaddy.li/watch.php?id=<N>   (mandatory; else 403 "This player only works when embedded.")
     -> const SRC, CFG, CHANNEL="premium<N>", EDGE, MARK, CHAL{n,e,m}, TSITE

p = b64url( HMAC-SHA256( key = proofKeyBytes(), data = CHANNEL+"|"+CHAL.n+"|"+CHAL.e ) )

POST <location.pathname><location.search>          i.e. /premiumtv/daddy.php?id=<N>  (same origin)
     Content-Type: application/x-www-form-urlencoded;  cache: no-store;  credentials: same-origin
     redeem=1 & n=<CHAL.n> & e=<CHAL.e> & m=<CHAL.m> & p=<p> & cf-turnstile-response=<token>
     -> 200 {"ticket":"<opaque>"}                                      403 {"ticket":""} on any failure

GET  <EDGE>/api/playlist-token?slug=<CHANNEL>&tk=<ticket>    ("&tk=" appended only when a ticket exists)
     credentials: omit;  cache: no-store;  1000 ms AbortController
     -> 200 {"token":"<t>","ttl":<sec>,"k":"<b64url AES key>"}  |  403 {"error":"ticket"}

GET  cleanPlaylistUrl(SRC) + "?" + "t=" + enc(token) + "&_=" + Date.now()
```

`cleanPlaylistUrl` strips any existing `_=` / `t=` params, preserves everything else:

```js
function cleanPlaylistUrl(u) {
    const q = u.indexOf('?');
    if (q < 0) return u;
    const kept = u.slice(q + 1).split('&').filter(kv => kv && !/^(_|t)=/.test(kv));
    return u.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
}
// caller:
url = cleanPlaylistUrl(url);
url += (url.includes('?') ? '&' : '?') + (token ? 't=' + encodeURIComponent(token) + '&' : '') + '_=' + Date.now();
```

For id 61 the final URL is exactly `https://edge.wedd48c.top/premium61/index.m3u8?t=<token>&_=<ms>`.

---

## 2. `proofKeyBytes()` — exact constant

```js
function proofKeyBytes() {
    const s = "b7fec5"+'f0' + ("095bed"+'75') + ("e5ef5f"+'52') + ("22a732"+'a4') +
              ("1343b1"+'eb') + ("b65f64"+'90') + ("d926ea"+'f7') + ("538b31"+'37');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
}
```

* Hex string: `b7fec5f0095bed75e5ef5f5222a732a41343b1ebb65f6490d926eaf7538b3137` (64 chars → 32 bytes)
* Bytes: `[183,254,197,240,9,91,237,117,229,239,95,82,34,167,50,164,19,67,177,235,182,95,100,144,217,38,234,247,83,139,49,55]`
* Static — it is a literal in the bundle, not per-session.

## 3. `p` — exact WebCrypto calls

```js
crypto.subtle.importKey("raw", proofKeyBytes(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  .then(k => crypto.subtle.sign("HMAC", k,
        new TextEncoder().encode(CHANNEL + '|' + CHAL['n'] + '|' + CHAL['e'])))
  .then(sig => ... b64urlFromBuf(sig) ...)
```

Confirmed: HMAC-SHA256, raw key import, `["sign"]` usage, message is exactly `CHANNEL|n|e`
(`e` is string-coerced by `+`). `b64urlFromBuf` = `btoa(binaryString)` → `+`→`-`, `/`→`_`, strip `=`
(standard base64url, no padding). Node equivalent: `createHmac('sha256', key).update(msg).digest()` then base64url.

## 4. Redeem POST — exact target and body

```js
fetch(location.pathname + location.search, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
      redeem: '1',
      n:  CHAL['n'],
      e:  String(CHAL['e']),
      m:  CHAL['m'],
      p:  b64urlFromBuf(sig),
      'cf-turnstile-response': tsToken
  }).toString(),
  cache: "no-store",
  credentials: "same-origin"
})
```

**Six fields, exactly in that order.** No cookie is set by the embed page (`Set-Cookie` absent); `credentials`
is same-origin only. `redeem` is the literal string `"1"` — omitting it makes the endpoint serve the HTML
page instead (observed: 200 `text/html`).

Response field: `issuedTicket = resp.ticket`. There is no other field read. On failure the body is
`{"ticket":""}`.

## 5. Playlist-token request

```js
const tk = ticket ? "&tk=" + encodeURIComponent(ticket) : '';
fetch(EDGE + "/api/playlist-token?slug=" + encodeURIComponent(CHANNEL) + tk,
      { cache: "no-store", credentials: "omit", signal })
  .then(r => (r.ok || r.status === 403) ? r.json().catch(() => null) : null)
```

Fields read: `resp.error` (`=== "ticket"` → `reloadForTicket()`), `resp.token`, `resp.ttl`, `resp.k`.
Path is `/api/playlist-token`, param names `slug` then `tk`. Fetch from `EDGE`, not from the embed origin.

## 6. Token TTL / caching / retry

```js
const ttl = Math.max(0x14, Number(resp.ttl) || 0x78);   // seconds, floor 20, default 120
const now = Date.now();
playToken = { value: resp.token,
              renewAt:  now + ttl * 500,     // ttl/2 s  -> background refresh
              expiresAt: now + ttl * 1000 - 2000 };
if (resp.k) rememberPlayKey(resp.token, resp.k);
```

* `currentPlaylistToken()` → `playToken && Date.now() < playToken.expiresAt ? playToken.value : ''`
* `playlistToken()` returns a live token immediately and fires `fetchPlaylistToken()` in the background once
  `now >= renewAt`. On failure `playTokenRetryAt = Date.now() + 1000` and callers get `''`.
* `issuedTicket` is memoised for the page lifetime (no expiry); a `typeof TICKET === "string"` global
  short-circuits the redeem. `TICKET` is **not** emitted by the current embed page (0 occurrences) → dead code.
* `reloadForTicket()`: `if (performance.now() < 60000) return; location.reload();` — at most one reload, only
  after 60 s on the page, triggered by `{"error":"ticket"}`.
* `MARK`: `if (MARK) { span.lw-mark textContent=MARK; documentElement.appendChild(span) }` — watermark only.

## 7. `k` / sealed playlists (AES-CTR)

When the token response carries `k` the m3u8 may be *sealed*: `playlistSealed(data, token)` is true when
`playKeys.has(token)` and `data.indexOf("://") === -1` (no plaintext URLs). `openPlaylist` imports `k` as
`AES-CTR` (`["decrypt"]`), keeps all `#` lines, tracks `#EXT-X-MEDIA-SEQUENCE` as a 64-bit counter, builds a
16-byte IV (`setUint32(8, floor(seq/2^32))`, `setUint32(12, seq>>>0)`, `length: 64` bits), decrypts each
non-comment base64url line (incrementing `seq`) and rejoins. `playKeys` is a `Map` capped at 5 entries.

## 8. Live evidence (2026-11-10, ~17:35 UTC)

```
GET  /premiumtv/daddy.php?id=61  + Referer thedaddy.li        200 text/html 657290 B
     CHANNEL=premium61  EDGE=https://edge.wedd48c.top  SRC=.../premium61/index.m3u8
     CHAL={"n":"cb5f2c649073749451c9c93919f40ec1","e":1794332205,"m":"4beed085c662f1d8c1d9340867fbe156"}
     TSITE=0x4AAAAAAF7J_a5qgDLdsENU  (same for ids 61/405/667/316)
     `e` = unix expiry ~60 s after render; `n`, `m` regenerate on every page load.
POST same URL (redeem=1&n&e&m&p as above, no cf-turnstile-response)
     403 application/json {"ticket":""}
GET  edge.../premium61/index.m3u8[?_=<ms>]                    403, 10 B "forbidden\n"
     access-control-allow-origin: https://dembed.st     (earlier same-day capture: 15 B "token required")
GET  edge.../api/playlist-token?slug=premium61[&tk=...]       403 "forbidden\n"  (tk absent/empty/random/= p)
```

No playlist could be retrieved, so the master/variant/segment checks are **not** demonstrated — the edge
rejects before any manifest is served.

### Failure matrix — every redeem variant returns the same 403 `{"ticket":""}`

A no field · B empty · C dummy `XXXX.DUMMY.DUMMY` · D wrong `p` · E no `p` · F wrong `n` · G wrong `m` ·
H expired `e` · I `redeem=0` → all **403** `{"ticket":""}`.
J no `redeem` field → **200** `text/html` (the HTML page; the redeem branch is never entered).

## 9. The hard gate

**Cloudflare Turnstile is the only hard gate, and it is on the redeem step.** The bundle itself refuses to
build the request without it:

```js
return issuedFlight = fetchTurnstileToken().then(ts => {
    if (!ts) return denyPageTicket();          // no request is even sent
```

`fetchTurnstileToken()` renders `window.turnstile.render(document.getElementById('ts'), {sitekey: TSITE,
action: "watch", retry: "auto", 'refresh-expired': "never", ...})`, resolves the callback token or `''`
on error/timeout (120 s), and removes the widget afterwards. The POST is never issued with an empty token.

The server accepts no substitute: empty, omitted and dummy tokens are indistinguishable (403 `{"ticket":""}`),
as is a correctly computed `p`. Latency is ~0.22–0.33 s for both cases, consistent with a server-side
`siteverify` call, but **the check order is UNKNOWN** — the endpoint collapses all redeem failures into one
response, so `p`/`m`/`e` may be validated before or after Turnstile.

A legitimate client is a real browser: the embed page runs in an iframe on `thedaddy.li`, Turnstile solves and
returns `cf-turnstile-response`, and the same-page POST carries the Cloudflare cookie context. There is no
token-free path: all four channel ids tested emit a non-empty `TSITE`, and the edge 403s every manifest and
token request that lacks a server-issued ticket.

## 10. UNKNOWN / how to resolve

* Whether `p` is validated, and whether `m` is an HMAC of the challenge — needs one valid Turnstile token.
  With `--ts <token>` the PoC reports `{"ticket":...}` vs `{"ticket":""}` for right/wrong `p` in one run.
* Ticket TTL (server-side) — not exposed in any response; the client caches it for the page lifetime.
* Whether `k` is always present, and whether any channel currently ships a sealed playlist.

## 11. PoC

`./dlhd-token.mjs` (Node ≥ 18):

```
node dlhd-token.mjs 61                  # full flow; stops at the Turnstile gate
node dlhd-token.mjs 61 --ts <token>     # complete flow, prints the final playlist URL
```

Fetches the embed page (Chrome UA + `Referer: https://thedaddy.li/watch.php?id=<N>`), parses
`SRC/CHANNEL/EDGE/CHAL/TSITE`, computes `p` with `node:crypto` HMAC-SHA256, POSTs the six-field redeem, calls
`/api/playlist-token?slug=…&tk=…`, and prints `cleanPlaylistUrl(SRC)?t=<token>&_=<ms>` plus the first 20
lines of the playlist. Without `--ts` it stops at step 3 with the observed `403 {"ticket":""}`.
