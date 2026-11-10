#!/usr/bin/env node
/**
 * DLHD / dembed.st token-protocol PoC
 *
 * Flow recovered from daddy.min.js (see PROTOCOL.md):
 *  1. GET https://dembed.st/premiumtv/daddy.php?id=<N>  (Referer must be a thedaddy.li page)
 *     -> extracts CHANNEL, EDGE, CHAL{n,e,m}, TSITE, SRC
 *  2. p = base64url(HMAC-SHA256(key = proofKeyBytes(), msg = CHANNEL + '|' + CHAL.n + '|' + CHAL.e))
 *  3. POST the same embed URL, form-encoded:
 *       redeem=1 & n & e & m & p & cf-turnstile-response
 *     -> JSON { ticket }
 *  4. GET <EDGE>/api/playlist-token?slug=<CHANNEL>&tk=<ticket>
 *     -> JSON { token, ttl, k? }
 *  5. playlist = cleanPlaylistUrl(SRC) + '?t=' + token + '&_=' + Date.now()
 *
 * Usage:
 *   node dlhd-token.mjs 61 [--ts <cloudflare-turnstile-token>] [--verbose]
 */
import { createHmac } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Verbatim from proofKeyBytes() in daddy.min.js:
//   "b7fec5"+"f0"+"095bed"+"75"+"e5ef5f"+"52"+"22a732"+"a4"+
//   "1343b1"+"eb"+"b65f64"+"90"+"d926ea"+"f7"+"538b31"+"37"
const PROOF_KEY_HEX =
  'b7fec5f0095bed75e5ef5f5222a732a41343b1ebb65f6490d926eaf7538b3137';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function proofKeyBytes() {
  return Buffer.from(PROOF_KEY_HEX, 'hex'); // proofKeyBytes(): hex string -> Uint8Array
}

export function computeP(channel, n, e) {
  // crypto.subtle.importKey('raw', proofKey, {name:'HMAC',hash:'SHA-256'}, false, ['sign'])
  // crypto.subtle.sign('HMAC', key, TextEncoder().encode(CHANNEL+'|'+n+'|'+e))
  return b64url(createHmac('sha256', proofKeyBytes()).update(`${channel}|${n}|${e}`).digest());
}

function parseEmbed(html) {
  const grab = (re) => (html.match(re) || [])[1];
  return {
    SRC: grab(/const SRC\s*=\s*"([^"]+)"/),
    CFG: grab(/const CFG\s*=\s*(\{.*?\})\s*;/),
    CHANNEL: grab(/const CHANNEL\s*=\s*"([^"]+)"/),
    EDGE: grab(/const EDGE\s*=\s*"([^"]+)"/),
    MARK: grab(/const MARK\s*=\s*"([^"]*)"/),
    CHAL: JSON.parse(grab(/const CHAL\s*=\s*(\{.*?\})\s*;/) || 'null'),
    TSITE: grab(/const TSITE\s*=\s*"([^"]+)"/),
    TICKET: grab(/const TICKET\s*=\s*"([^"]+)"/),
  };
}

// cleanPlaylistUrl(): drop `_=` and `t=` params from the query, keep the rest.
export function cleanPlaylistUrl(url) {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const kept = url
    .slice(q + 1)
    .split('&')
    .filter((kv) => kv && !/^(_|t)=/.test(kv));
  return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
}

async function main() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => /^\d+$/.test(a)) || '61';
  const tsIdx = argv.indexOf('--ts');
  const ts = tsIdx >= 0 ? argv[tsIdx + 1] : undefined;
  const verbose = argv.includes('--verbose');
  const site = `https://dembed.st/premiumtv/daddy.php?id=${id}`;
  const referer = `https://thedaddy.li/watch.php?id=${id}`;
  const H = { 'User-Agent': UA, Referer: referer, Origin: 'https://thedaddy.li', Accept: '*/*' };

  console.log(`[*] GET ${site}`);
  const page = await fetch(site, { headers: H, redirect: 'follow' });
  const html = await page.text();
  console.log(`    -> ${page.status} ${page.headers.get('content-type')} ${html.length} bytes`);
  if (page.status !== 200) {
    console.log(html.slice(0, 300));
    return;
  }
  const cfg = parseEmbed(html);
  console.log(`    CHANNEL=${cfg.CHANNEL} EDGE=${cfg.EDGE}`);
  console.log(`    SRC=${cfg.SRC}`);
  console.log(`    CHAL=${JSON.stringify(cfg.CHAL)}  TSITE=${cfg.TSITE}`);
  if (cfg.TICKET) console.log(`    TICKET(server-injected)=${cfg.TICKET}`);
  if (!cfg.CHAL) return console.log('[!] no CHAL -> cannot mint p');

  const p = computeP(cfg.CHANNEL, cfg.CHAL.n, cfg.CHAL.e);
  console.log(`[*] p = ${p}  (HMAC-SHA256 key=${PROOF_KEY_HEX.slice(0, 8)}… over "${cfg.CHANNEL}|${cfg.CHAL.n}|${cfg.CHAL.e}")`);

  const body = new URLSearchParams({
    redeem: '1',
    n: cfg.CHAL.n,
    e: String(cfg.CHAL.e),
    m: cfg.CHAL.m,
    p,
  });
  if (ts !== undefined) body.set('cf-turnstile-response', ts);
  console.log(`[*] POST ${site}  body=${body.toString()}${ts === undefined ? '  (no cf-turnstile-response)' : ''}`);

  const rd = await fetch(site, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Origin: 'https://thedaddy.li',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
    },
    body: body.toString(),
    cache: 'no-store',
  });
  const rtext = await rd.text();
  console.log(`    -> ${rd.status} ${rd.headers.get('content-type')} ${JSON.stringify(rtext.slice(0, 300))}`);
  let ticket;
  try { ticket = JSON.parse(rtext).ticket; } catch { }
  if (!ticket) return console.log('[!] redeem failed (no ticket). Turnstile is the gate; supply --ts <token>.');
  console.log(`[*] ticket = ${ticket}`);

  const tokUrl = `${cfg.EDGE}/api/playlist-token?slug=${encodeURIComponent(cfg.CHANNEL)}&tk=${encodeURIComponent(ticket)}`;
  console.log(`[*] GET ${tokUrl}`);
  const tr = await fetch(tokUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://dembed.st/', Origin: 'https://dembed.st', Accept: '*/*' },
    cache: 'no-store',
  });
  const ttext = await tr.text();
  console.log(`    -> ${tr.status} ${JSON.stringify(ttext.slice(0, 400))}`);
  let tj = {};
  try { tj = JSON.parse(ttext); } catch { }
  if (!tj.token) return console.log('[!] no playlist token');

  const finalUrl =
    cleanPlaylistUrl(cfg.SRC) +
    (cleanPlaylistUrl(cfg.SRC).includes('?') ? '&' : '?') +
    `t=${encodeURIComponent(tj.token)}&_=${Date.now()}`;
  console.log(`[*] ttl=${tj.ttl} k=${tj.k ? tj.k.slice(0, 16) + '…' : '(none)'}`);
  console.log(`[+] PLAYLIST: ${finalUrl}`);

  const pl = await fetch(finalUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://dembed.st/', Origin: 'https://dembed.st', Accept: '*/*' },
  });
  const plText = await pl.text();
  console.log(`[*] GET playlist -> ${pl.status} ${pl.headers.get('content-type')} ${plText.length} bytes`);
  console.log(plText.split('\n').slice(0, 20).join('\n'));
  if (verbose) console.log(plText);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERR', e); process.exit(1); });
}
