/**
 * Best-effort fallback provider. Small, defensive, and never allowed to hang:
 * the whole chain is capped at 8 seconds and every failure returns null.
 *
 * Tries the site's /player/ folder, which for some ids hands out a wideiptv.top
 * player that inlines a plaintext HLS URL. Most ids stay on dead providers, in
 * which case this simply returns null and providers/index reports the primary
 * provider's failure.
 */

import { SITE, PROVIDER } from '../config.js';
import { fetchText } from '../http.js';
import { debug } from '../log.js';

const OVERALL_TIMEOUT_MS = 8000;
const TTL_MS = 10 * 60 * 1000;
const SITE_REFERER = `${SITE}/`;
const WIDE_REFERER = 'https://wideiptv.top/';

function decodeHtmlUrls(text) {
  return String(text)
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');
}

function findPlaylistUrl(html) {
  const text = decodeHtmlUrls(html);
  const absolute = text.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
  if (absolute) return absolute[0];
  return null;
}

function findIframes(html) {
  const urls = [];
  const re = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw) urls.push(decodeHtmlUrls(raw));
  }
  return urls;
}

function remainingMs(startedAt) {
  return OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
}

function requestOpts(startedAt, referer) {
  const left = remainingMs(startedAt);
  if (left <= 250) return null;
  return { headers: { Referer: referer }, timeoutMs: left, retries: 0 };
}

async function verifyPlaylist(url, startedAt) {
  const opts = requestOpts(startedAt, WIDE_REFERER);
  if (!opts) return null;
  try {
    const text = await fetchText(url, opts);
    if (!/^\s*#EXTM3U/i.test(text)) return null;
    if (!/#EXTINF|#EXT-X-STREAM-INF/i.test(text)) return null;
    return {
      url,
      headers: { Referer: WIDE_REFERER },
      ttlMs: TTL_MS,
      provider: PROVIDER.FALLBACK,
    };
  } catch {
    return null;
  }
}

async function attempt(id, startedAt) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 0) return null;

  const playerUrl = `${SITE}/player/stream-${numericId}.php`;
  const playerOpts = requestOpts(startedAt, SITE_REFERER);
  if (!playerOpts) return null;

  let page;
  try {
    page = await fetchText(playerUrl, playerOpts);
  } catch (err) {
    debug('fallback: /player/ page unavailable', { id: numericId, reason: err.code ?? err.message });
    return null;
  }

  const direct = findPlaylistUrl(page);
  if (direct) return verifyPlaylist(direct, startedAt);

  const wideIframe = findIframes(page).find((src) => /wideiptv/i.test(src));
  if (!wideIframe) return null;

  const outerUrl = new URL(wideIframe, SITE).toString();
  const outerOpts = requestOpts(startedAt, SITE_REFERER);
  if (!outerOpts) return null;

  let outerHtml;
  try {
    outerHtml = await fetchText(outerUrl, outerOpts);
  } catch (err) {
    debug('fallback: wideiptv wrapper unavailable', { id: numericId, reason: err.code ?? err.message });
    return null;
  }

  let candidate = findPlaylistUrl(outerHtml);
  if (!candidate) {
    const innerSrc = findIframes(outerHtml).find(
      (src) => /\/player\//i.test(src) || /wideiptv/i.test(src),
    );
    if (!innerSrc) return null;

    const innerUrl = new URL(innerSrc, outerUrl).toString();
    const innerOpts = requestOpts(startedAt, WIDE_REFERER);
    if (!innerOpts) return null;

    let innerHtml;
    try {
      innerHtml = await fetchText(innerUrl, innerOpts);
    } catch (err) {
      debug('fallback: wideiptv player unavailable', {
        id: numericId,
        reason: err.code ?? err.message,
      });
      return null;
    }
    candidate = findPlaylistUrl(innerHtml);
  }

  if (!candidate) return null;
  let absolute;
  try {
    absolute = new URL(candidate, outerUrl).toString();
  } catch {
    return null;
  }
  return verifyPlaylist(absolute, startedAt);
}

function withDeadline(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * @param {number|string} id
 * @returns {Promise<{url:string,headers:Record<string,string>,ttlMs:number,provider:string}|null>}
 */
export async function resolve(id) {
  const startedAt = Date.now();
  try {
    return await withDeadline(attempt(id, startedAt), OVERALL_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export default { resolve };
