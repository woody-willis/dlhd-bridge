/**
 * Primary provider: tossequip.net (the site's /cast/ player).
 *
 * Flow (verified live 2026-11-10):
 *   1. GET https://thedaddy.li/cast/stream-<id>.php  (Referer: site)
 *        -> <iframe src="https://tossequip.net/e/<opaque-token>">
 *   2. GET https://tossequip.net/e/<token>          (Referer: site)
 *        -> inline script with window._econfig = "<base64>"
 *   3. Decode _econfig exactly like /assets/stream.js (see decodeEconfig).
 *   4. stream_url is a flat HLS media playlist that needs
 *      Referer: https://tossequip.net/ for its segments.
 *
 * No caching here; providers/index.js owns TTL + single-flight.
 */

import { SITE, PROVIDER } from '../config.js';
import { fetchText } from '../http.js';
import { debug } from '../log.js';

const TTL_MS = 10 * 60 * 1000;
const REFERER = `${SITE}/`;
const PROVIDER_REFERER = 'https://tossequip.net/';
// The token page rejects some Chrome builds with 403 while accepting others.
// Use a known-good browser UA explicitly, and keep a second one for retries.
const TOKEN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const TOKEN_UA_ALT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';

export class ResolveError extends Error {
  /**
   * @param {string} reason one of iframe-missing | provider-unsupported |
   *   token-page | config-missing | decode-failed | no-stream-url | http |
   *   all-failed | invalid-id
   * @param {string} message
   * @param {{cause?: unknown, status?: number, provider?: string, url?: string,
   *   host?: string, attempts?: string[], cachedFailure?: boolean,
   *   retryAfterMs?: number}} [opts]
   */
  constructor(reason, message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ResolveError';
    this.reason = reason;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.provider !== undefined) this.provider = opts.provider;
    if (opts.url !== undefined) this.url = opts.url;
    if (opts.host !== undefined) this.host = opts.host;
    if (opts.attempts !== undefined) this.attempts = opts.attempts;
    if (opts.cachedFailure !== undefined) this.cachedFailure = opts.cachedFailure;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

function unescapeAttr(value) {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#38;/g, '&')
    .trim();
}

function extractIframeSrc(html) {
  const srcs = [];
  const re = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const src = unescapeAttr(match[1] ?? match[2] ?? match[3] ?? '');
    if (src) srcs.push(src);
  }
  return srcs;
}

/**
 * Player host named by an iframe we cannot script. Ads are ignored so a page
 * that simply has no player does not get misreported as a provider we lack.
 *
 * @param {string[]} srcs
 * @returns {string} bare hostname, or '' when nothing player-like is present
 */
function firstPlayerHost(srcs) {
  const ignored = /(^|\.)(google|gstatic|fonts|cloudflare|profitableratecpmnetwork|effectivecpmnetwork|adsboosters|kzt2afc1rp52|llvpn|doubleclick|googlesyndication|googletagmanager)\b/i;
  for (const src of srcs) {
    let url;
    try {
      url = new URL(src.startsWith('//') ? `https:${src}` : src, 'https://thedaddy.li/');
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (ignored.test(url.hostname)) continue;
    if (/tossequip\.net$/i.test(url.hostname)) continue;
    return url.hostname.toLowerCase();
  }
  return '';
}

function extractEconfig(html) {
  // Tolerant of `window._econfig`, `var _econfig`, `let _econfig`, and either
  // quote style. The payload is base64 (A-Za-z0-9+/=), sometimes with
  // whitespace inserted by the template.
  const re = /_econfig\s*=\s*(?:"([^"]{20,})"|'([^']{20,})')/i;
  const match = html.match(re);
  if (!match) return '';
  return (match[1] ?? match[2] ?? '').replace(/\s+/g, '');
}

function b64Binary(value) {
  return Buffer.from(value, 'base64').toString('binary');
}

function permutations(values) {
  if (values.length <= 1) return [values.slice()];
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const rest = values.slice(0, i).concat(values.slice(i + 1));
    for (const tail of permutations(rest)) result.push([values[i], ...tail]);
  }
  return result;
}

const PERMUTATIONS = permutations([0, 1, 2, 3]);

function decodeWith(raw, dropIndex, permutation) {
  const chunkLength = Math.floor(raw.length / 4);
  if (chunkLength <= dropIndex) throw new Error('chunk too small');

  const chunks = [];
  for (let i = 0; i < 4; i++) {
    chunks.push(raw.slice(i * chunkLength, (i + 1) * chunkLength));
  }

  const ordered = new Array(4);
  for (let i = 0; i < 4; i++) {
    const chunk = chunks[i];
    const trimmed = chunk.slice(0, dropIndex) + chunk.slice(dropIndex + 1);
    ordered[permutation[i]] = b64Binary(trimmed);
  }

  const text = b64Binary(ordered.join(''));
  return JSON.parse(text);
}

/**
 * Decode `_econfig` the way the live player does.
 *
 * The live `/assets/stream.js` function `_0x1b7ade` does:
 *   raw = atob(b64)
 *   split raw into 4 equal chunks (floor(len/4), trailing bytes dropped)
 *   for i in 0..3: drop chunk[i][3], atob it, store at out[PERM[i]]
 *   return JSON.parse(atob(out.join('')))
 * with PERM = [2, 0, 3, 1] and drop index 3.
 *
 * Brute force fallback: all 24 chunk permutations x drop indexes 0..7, which
 * covers the permutation/offset changing without a code update.
 *
 * @param {string} value raw base64 from window._econfig
 * @returns {{json: Object, variant: string}}
 */
export function decodeEconfig(value) {
  if (!value || typeof value !== 'string') throw new Error('empty _econfig');

  let raw;
  try {
    raw = b64Binary(value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  } catch (err) {
    throw new Error(`invalid base64: ${err.message}`);
  }
  if (raw.length < 32) throw new Error('payload too short');

  const attempts = [];
  // Documented/exact live variant first.
  attempts.push({ dropIndex: 3, permutation: [2, 0, 3, 1], variant: 'documented' });

  for (let dropIndex = 0; dropIndex <= 7; dropIndex++) {
    for (const permutation of PERMUTATIONS) {
      if (dropIndex === 3 && permutation.join(',') === '2,0,3,1') continue;
      attempts.push({ dropIndex, permutation, variant: `brute` });
    }
  }

  let parsedAny = null;
  let firstParsedVariant = '';
  for (const attempt of attempts) {
    let parsed;
    try {
      parsed = decodeWith(raw, attempt.dropIndex, attempt.permutation);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    if (!parsedAny) {
      parsedAny = parsed;
      firstParsedVariant = `${attempt.variant} drop=${attempt.dropIndex} perm=[${attempt.permutation.join(',')}]`;
    }
    if (typeof parsed.stream_url === 'string' && parsed.stream_url.length > 0) {
      const variant = `${attempt.variant} drop=${attempt.dropIndex} perm=[${attempt.permutation.join(',')}]`;
      debug('tossequip: _econfig decoded', { variant });
      return { json: parsed, variant };
    }
  }

  if (parsedAny) {
    const err = new Error(`decoded config has no stream_url (${firstParsedVariant})`);
    err.code = 'NO_STREAM_URL';
    throw err;
  }
  throw new Error('no chunk permutation produced valid JSON');
}

function asResolveError(reason, message, opts) {
  return new ResolveError(reason, message, { provider: PROVIDER.TOSSEQUIP, ...opts });
}

/**
 * Resolve a channel/event id to a playable HLS URL via tossequip.net.
 *
 * @param {number|string} id
 * @returns {Promise<{url:string,headers:Record<string,string>,ttlMs:number,provider:string,meta?:{title?:string,logo?:string}}>}
 */
export async function resolve(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 0) {
    throw asResolveError('http', `invalid channel id ${JSON.stringify(id)}`);
  }

  const castUrl = `${SITE}/cast/stream-${numericId}.php`;
  let castHtml;
  try {
    castHtml = await fetchText(castUrl, { headers: { Referer: REFERER }, retries: 1 });
  } catch (err) {
    throw asResolveError('http', `cast page failed: ${err.message}`, {
      cause: err,
      status: err.status,
    });
  }

  const iframeSrcs = extractIframeSrc(castHtml);
  let tokenUrl = iframeSrcs.find((src) => /tossequip\.net\/e\//i.test(src));
  if (!tokenUrl) {
    // Tolerate markup that prints the URL outside an iframe tag.
    const direct = castHtml.match(/https?:\/\/tossequip\.net\/e\/[A-Za-z0-9_-]+/i);
    if (direct) tokenUrl = direct[0];
  }
  if (!tokenUrl) {
    // The site serves different players per id. If this page embeds a player
    // we cannot script, say so explicitly: it is not a transient failure and
    // retrying it only generates load.
    const otherHost = firstPlayerHost(iframeSrcs);
    if (otherHost) {
      throw asResolveError(
        'provider-unsupported',
        `id ${numericId} is served by ${otherHost}, not tossequip`,
        { url: castUrl, host: otherHost },
      );
    }
    throw asResolveError('iframe-missing', `no tossequip iframe on /cast/stream-${numericId}.php`, {
      url: castUrl,
    });
  }
  if (tokenUrl.startsWith('//')) tokenUrl = `https:${tokenUrl}`;

  let tokenHtml;
  let lastTokenError;
  for (const userAgent of [TOKEN_UA, TOKEN_UA_ALT]) {
    try {
      tokenHtml = await fetchText(tokenUrl, {
        headers: {
          Referer: REFERER,
          Accept: 'text/html,application/xhtml+xml',
          'user-agent': userAgent,
        },
        retries: 0,
      });
      lastTokenError = null;
      break;
    } catch (err) {
      lastTokenError = err;
      // A 403 here is usually a UA/rate rule; try the alternate browser UA.
      if (err.status !== 403) break;
      debug('tossequip: token page 403, retrying with alternate UA', { id: numericId });
    }
  }
  if (lastTokenError) {
    throw asResolveError('http', `token page failed: ${lastTokenError.message}`, {
      cause: lastTokenError,
      status: lastTokenError.status,
      url: tokenUrl,
    });
  }

  if (!tokenHtml || tokenHtml.length < 200 || /<title>\s*Not allowed\s*<\/title>/i.test(tokenHtml)) {
    throw asResolveError('token-page', `token page rejected the request for id ${numericId}`, {
      url: tokenUrl,
    });
  }

  const encoded = extractEconfig(tokenHtml);
  if (!encoded) {
    throw asResolveError('config-missing', `no _econfig in token page for id ${numericId}`, {
      url: tokenUrl,
    });
  }

  let decoded;
  try {
    decoded = decodeEconfig(encoded);
  } catch (err) {
    const reason = err.code === 'NO_STREAM_URL' ? 'no-stream-url' : 'decode-failed';
    throw asResolveError(reason, `_econfig decode failed: ${err.message}`, {
      cause: err,
      url: tokenUrl,
    });
  }

  const cfg = decoded.json;
  if (typeof cfg.stream_url !== 'string' || cfg.stream_url.length === 0) {
    throw asResolveError('no-stream-url', `no stream_url for id ${numericId}`, { url: tokenUrl });
  }

  let streamUrl;
  try {
    streamUrl = new URL(cfg.stream_url, tokenUrl).toString();
  } catch (err) {
    throw asResolveError('no-stream-url', `invalid stream_url for id ${numericId}`, {
      cause: err,
      url: tokenUrl,
    });
  }

  const result = {
    url: streamUrl,
    headers: { Referer: PROVIDER_REFERER },
    ttlMs: TTL_MS,
    provider: PROVIDER.TOSSEQUIP,
  };

  const meta = {};
  if (typeof cfg.title === 'string' && cfg.title.trim()) meta.title = cfg.title.trim();
  if (typeof cfg.logo === 'string' && cfg.logo.trim()) meta.logo = cfg.logo.trim();
  if (Object.keys(meta).length > 0) result.meta = meta;

  return result;
}

export default { resolve, decodeEconfig, ResolveError };
