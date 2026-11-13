# PROVIDER: waterera.net (successor to tossequip.net) — 2026-11-13

Read-only investigation. No Turnstile solving/bypass attempted. Every claim below is
backed by a quoted deobfuscated fragment or an observed HTTP status/body from this host.

## 1. Artifacts and deobfuscation

- Player page: `https://waterera.net/e/lavhlvnunx33l` (id 61), 200, 149 892 bytes,
  `set-cookie: hf1=1`, `server: cloudflare`. Same page as `/tmp/w61.html`.
- Script: `/assets/stream.js?_v=0.0.28`, 92 249 bytes, obfuscator.io. No base64 array
  layer: `_0x525f()` returns a plain 261-entry string array; `_0x1d6f(a)` is
  `return _0x525f()[a-0x13a]`.
- Rotation replay: the leading IIFE `(function(_0x1abd39,_0x1ff9e5){…}(_0x525f,0x55935)`
  is **not** self-balanced (it is the first element of a comma expression), so slice from
  `var _0xc6cd8c=` to the literal `}(_0x525f,0x55935)` and eval that as
  `(function(a,b){…})(_0x525f,0x55935)`. Array rotates until the checksum `0x55935` matches.
- Then substitute every alias of `_0x1d6f` (`var X=_0x1d6f`) at numeric call sites
  (654 replacements), convert `obj["x"]`→`obj.x`, `npx -y js-beautify@1`.
  Scripts: `…/T/opencode/w-arr2-20261113.js`, `w-deob-20261113.js`; output `/tmp/wstream.pretty.js`.

## 2. Mechanism that yields the HLS URL (numbered)

1. `GET https://thedaddy.li/cast/stream-<id>.php` with `Referer: https://thedaddy.li/`
   → 200, 660 124 bytes, contains `<iframe src="https://waterera.net/e/<token>">`
   (id 61 `lavhlvnunx33l`, 405 `acgheutl8kp7b`, 316 `86xman0guksmz`).
2. `GET https://waterera.net/e/<token>` with `Referer: https://thedaddy.li/` → 200,
   149 892 bytes, `window._econfig='<base64>'`. Without that Referer the same URL is
   **200** but only 846 bytes, `<title>Not allowed</title>` / "This stream is domain protected".
3. `_econfig` decode is unchanged (`_0x5123f0`, drop index 3, PERM `[2,0,3,1]`):
   `const _0x569c31=[0x2,0x0,0x3,0x1] … _0x2eaa06=_0x2eaa06['slice'](0x0,0x3)+…slice(0x4) … JSON.parse(atob(join))`.
   Decoded keys: `id, swarm_id, p2p, p2p_tracker, swarmcloud, swarmcloud_token, domainlocked,
   autoplay, play_3_secs, sandbox_block, devtools_block, hframes_inject_secs, pop1, debug,
   alt_domain, ts, turnstile_key, turnstile_hash, pops, hframes`. **No `stream_url`.**
4. Because `turnstile_key` is set, the player never plays directly — it renders Turnstile
   and only after the challenge callback does the one and only `fetch()` in the bundle:
   ```js
   if (typeof _0x5d7105.turnstile_key != "undefined" && _0x5d7105['turnstile_key']) {
     turnstile.render("#turnstile-container", { sitekey: _0x5d7105.turnstile_key,
       'appearance': "interaction-only", 'theme': "dark",
       callback: _0x2e8f1d => { fetch("/turnstile/" + _0x5d7105['id'], {
         'method': "POST",
         'headers': { 'Content-Type': 'application/x-www-form-urlencoded' },
         'body': new URLSearchParams({ 'hash': _0x5d7105['turnstile_hash'],
           'token': _0x2e8f1d, 'ts': _0x5d7105['ts'] }) })
         .then(r=>r.json()).then(_0x449d50 => { _0x449d50['success'] ?
           (_0x5d7105['stream_url']=_0x449d50['stream_url'],
            _0x5d7105['stream_url_nop2p']=_0x449d50['stream_url_nop2p'], _0x5e87a3())
           : _0x39f854('Captcha failed. Please reload and try again'); }); }});
   } else _0x5e87a3();
   ```
5. Response JSON contract (inferred from the two property reads, success path only):
   `{"success":true,"stream_url":"…","stream_url_nop2p":"…"}`. URL selection:
   `P2pEngineHls['isSupported']() ? stream_url : stream_url_nop2p` (swarmcloud branch), else
   `_0x5d7105['p2p'] || !_0x5d7105['url_nop2p'] ? stream_url : stream_url_nop2p` —
   note it tests `url_nop2p`, which the config never carries, so `stream_url` always wins there.
6. CDN shape: `https://8z09jo.7odxv0l067ka.net:8443/hls/<streamid>.m3u8?s=<sig>&e=<epoch>`
   (media playlist, no master). Signature and expiry are minted server-side; `e` ≈ ts+6 h.

## 3. Field semantics (verbatim use)

| field | use in stream.js |
|---|---|
| `id` | path segment of `POST /turnstile/<id>`; also seed of nothing else |
| `swarm_id` | `swarmId` / `channelId()` for P2P engine (`_0x2ab821 = new _0x901bb0({core:{swarmId:_0x5d7105['swarm_id']}})`) |
| `p2p_tracker` | `announceTrackers:[_0x5d7105['p2p_tracker']]` (`wss://hlspatch.net:3000`) |
| `p2p` | enables P2P; also decides which minted URL is played (step 5) |
| `swarmcloud` / `swarmcloud_token` | `P2PEngineHls.tryRegisterServiceWorker({token:_0x5d7105['swarmcloud_token'], 'sw': '/sw.js', 'live': true})` |
| `ts` | form field `ts`, bound to hash; page-load timestamp (1794601380→1794601740 across fetches) |
| `turnstile_key` | `sitekey` for `turnstile.render` (`0x4AAAAAAF7-QrheyFhpxofw`) |
| `turnstile_hash` | form field `hash`; rotates per page load (`2af2d8fb…`, `65641514…`, `65d965a7…`) |
| `alt_domain` | only: if sandbox detected and true → `document.body.innerHTML="Sandbox not allowed"`; else error overlay. **Not** a stream host switch |
| `domainlocked` | string-table entry only — **never read** in code |
| `pops` / `hframes` / `pop1` | popunder script injection and hidden iframes — ad payloads. Treated as data, not executed |

## 4. Is a Turnstile token required? YES — proof (all POSTs to `/turnstile/lavhlvnunx33l`)

| request | status | body |
|---|---|---|
| no `token` field | 400 | `{"error":"Invalid call"}` |
| `token=` (empty) | 400 | `{"error":"Invalid call"}` |
| `token=dummy` (valid fresh hash/ts) | 400 | `{"error":"Verification failed"}` |
| `token=dummy`, `hash=deadbeef` | 400 | `{"error":"Invalid hash"}` |
| `hash` from id 405 used on id 61 | 400 | `{"error":"Invalid hash"}` |
| `ts=0` | 400 | `{"error":"Invalid call"}` |
| same valid hash/ts reused 70 s later | 400 | `{"error":"Expired"}` |
| `GET` or `Content-Type: application/json` | 400 | `{"error":"Invalid call"}` |

`"Verification failed"` with a well-formed hash/ts proves the server calls Cloudflare
siteverify and rejects anything but a real token (an empty token is short-circuited as
"Invalid call"). No token can be produced without solving the challenge ⇒ **gated**.
Rate limit observed: 5 POSTs during 20:25:20–20:25:2x were fine; a 6th at 20:26:23 passed, then
the next two POSTs in the same second returned nginx `429 Too Many Requests` (564 bytes).

## 5. Live playback verification (2026-11-13 20:27–20:29 UTC)

- Same opaque token is still served by the legacy host: `GET https://tossequip.net/e/lavhlvnunx33l`
  with `Referer: https://thedaddy.li/` → 200, 150 116 bytes, `_econfig` keys include
  `stream_url, stream_url_nop2p` and **no** `turnstile_key`/`ts`. Confirmed for token
  `acgheutl8kp7b` too (150 117 bytes). Without Referer → 200/846 bytes "Not allowed".
- Decoded: `stream_url = https://8z09jo.7odxv0l067ka.net:8443/hls/k5atkajfhkgk1.m3u8?s=…&e=1794623264`.
- `GET` playlist with `Referer: https://tossequip.net/` → **200, 369 bytes**, body starts
  `#EXTM3U`, `#EXT-X-MEDIA-SEQUENCE:285`, 7 segment URIs → media playlist (no variant).
- `GET …/k5atkajfhkgk1-900704700.ts` `Referer: https://tossequip.net/` → **200, 3 241 308 bytes**,
  `video/mp2t`. id 405 playlist: 200, 380 bytes, `#EXT-X-MEDIA-SEQUENCE:4024290`.
- Header rules: playlist works with or without Referer; **segments require** a player origin.
  `Referer: https://waterera.net/` → 200 (2 470 508 bytes); `Referer: https://thedaddy.li/` → 403
  (555 bytes); no Referer → 403 (555 bytes). `User-Agent: curl/8.7.1` still 200 ⇒ UA irrelevant.
- Conclusion: the only reason waterera's URL is unreachable is the Turnstile POST. The token
  namespace is shared with tossequip, which still hands out the signed CDN URL unaided.

## 6. PoC

`node plan/waterera-poc.mjs <id>` (Node 22, zero deps, copied `_econfig` decoder).
It walks cast → player → `_econfig`, reports `stage:"turnstile-gated"` from waterera, then
(diagnostic mirror) requests `https://tossequip.net/e/<token>`, decodes `stream_url`, verifies
`#EXTM3U`, and prints playlist + `Referer` + `e` expiry. `WATERERA_TURNSTILE_TOKEN=<real token>`
exercises the POST instead (never solved by the script). Verified output:
id 61 → `…/hls/k5atkajfhkgk1.m3u8?s=zjvhSOO4xymAwRoXXQ3YFg&e=1794623341`, playlist 200/369 bytes;
id 405 → `…/hls/86xmlv9g4v55o.m3u8…`, playlist 200/380 bytes.

## 7. Recommended change to `src/providers/tossequip.js` (not applied)

1. `extractIframeSrc`/regex: accept any `/e/<token>` iframe, not just `tossequip.net`
   (line 240 `find(src => /tossequip\.net\/e\//i.test(src))` and line 243 direct match).
2. Derive `token` from that URL; then request `https://tossequip.net/e/<token>` (keep current
   decode + `stream_url` path). Evidence says this still works for ids 61/405/316.
3. If the mirror ever returns no `stream_url`, throw a distinct reason `turnstile-gated`
   instead of `no-stream-url`, so callers can fall back without retry storms; never retry a
   gated player page.
4. Header fix: segment `Referer` must be a player origin (`https://tossequip.net/` or
   `https://waterera.net/`); `https://thedaddy.li/` gets 403. Also keep the Chrome UA — it is
   ignored by the CDN but the token page's UA rule from 2026-11-10 still applies.
5. Do not model `turnstile_hash`/`ts` as reusable: both rotate per page load and expire in
   <70 s.

## 8. UNKNOWN

- Exact POST success body beyond `success`/`stream_url`/`stream_url_nop2p` (inferred from code,
  not observed — only a real token would resolve it).
- Whether `hash` is bound to `id`+`ts` (hash from id 405 on 61 → "Invalid hash"; could be either).
- Exact TTL of `ts`/`hash` (valid at 25 s, expired at 70 s; finer resolution needs more POSTs).
- Whether `tossequip.net` will keep serving `/e/<token>` without a challenge; it did on
  2026-11-13 for all three tokens. Monitor; if it 404s/redirects to waterera, provider is gated.
- Whether Turnstile `appearance:"interaction-only"` auto-passes for real Chrome profiles
  (irrelevant to a headless server) — a real browser was not tested.
