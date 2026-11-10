/**
 * HLS proxying: rewrite upstream playlists and stream segments through us.
 *
 * Clients only ever see `/stream/<id>.m3u8` and `/seg/<id>/<base64url>`, never
 * an upstream URL. Segment bodies are streamed with `pipeline`, not buffered.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { config } from '../config.js';
import { fetchText, UpstreamError } from '../http.js';
import * as log from '../log.js';
import {
  resolve as resolveProvider,
  invalidate as invalidateProvider,
} from '../providers/index.js';
import * as cache from './cache.js';

const RESOLVE_PREFIX = 'resolve:';
const RESOLVE_TTL_MS = config.resolveTtlSec * 1000;
const PLAYLIST_CACHE_CONTROL = 'no-cache, no-store, max-age=0';
const SEGMENT_CACHE_CONTROL = 'public, max-age=60';
const MAX_REDIRECTS = 3;

/** Hosts that are always allowed to serve segments. */
const STATIC_ALLOWED_BASES = Object.freeze(['tossequip.net', 'wideiptv.top']);

/** Additional exact hosts learned from successful resolve() results. */
const dynamicHosts = new Set();

function normaliseHostname(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

function hostAllowed(hostname) {
  const host = normaliseHostname(hostname);
  if (!host) return false;
  if (dynamicHosts.has(host)) return true;
  return STATIC_ALLOWED_BASES.some((base) => host === base || host.endsWith(`.${base}`));
}

/**
 * Add the host of a resolved stream URL to the dynamic segment allowlist.
 * @param {string} value
 */
export function rememberResolvedUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return;
    const host = normaliseHostname(url.hostname);
    if (host) dynamicHosts.add(host);
  } catch {
    /* ignore malformed URLs */
  }
}

/** @param {string} hostname */
export function isAllowedHost(hostname) {
  return hostAllowed(hostname);
}

/** @param {string} absoluteUrl */
export function encodeSegmentToken(absoluteUrl) {
  return Buffer.from(String(absoluteUrl), 'utf8').toString('base64url');
}

/**
 * Decode a segment token, enforcing base64url shape, https and the host
 * allowlist. Returns null for anything we must not fetch.
 *
 * @param {string} token
 * @returns {URL|null}
 */
export function decodeSegmentToken(token) {
  // The proxy path ends in a media extension so ffmpeg accepts it; strip it
  // before decoding (base64url never contains a dot).
  const dot = typeof token === 'string' ? token.lastIndexOf('.') : -1;
  const raw = dot > 0 ? token.slice(0, dot) : token;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) return null;
  let text;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Reject non-canonical encodings (including invalid UTF-8 replacement chars).
  if (Buffer.from(text, 'utf8').toString('base64url') !== raw) return null;

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!hostAllowed(url.hostname)) return null;
  return url;
}

/** Extensions ffmpeg's HLS demuxer accepts on segment URIs. */
const ALLOWED_EXTENSIONS = Object.freeze([
  'ts',
  'm4s',
  'mp4',
  'm4a',
  'm4v',
  'aac',
  'ac3',
  'eac3',
  'mp3',
  'webm',
  'm3u8',
  'm3u',
  'key',
  'bin',
  'vtt',
]);

/**
 * Pick a safe file extension for the proxy URL. ffmpeg refuses to fetch HLS
 * segments whose URL has no recognised media extension ("URL … is not in
 * allowed_segment_extensions"), so every proxy path must end in one.
 *
 * @param {string} absoluteUrl
 * @returns {string} extension including the dot, e.g. ".ts"
 */
function proxyExtension(absoluteUrl) {
  let pathname = '';
  try {
    pathname = new URL(absoluteUrl).pathname;
  } catch {
    return '.ts';
  }
  const match = pathname.match(/\.([A-Za-z0-9]{1,5})$/);
  const ext = match ? match[1].toLowerCase() : '';
  return ALLOWED_EXTENSIONS.includes(ext) ? `.${ext}` : '.ts';
}

function proxyPath(id, absoluteUrl) {
  return `/seg/${id}/${encodeSegmentToken(absoluteUrl)}${proxyExtension(absoluteUrl)}`;
}

function absoluteUpstreamUrl(value, baseUrl) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function rewriteTagUris(line, baseUrl, id) {
  return line.replace(/\b((?:SERVER-)?URI)="([^"]*)"/g, (match, name, value) => {
    const absolute = absoluteUpstreamUrl(value, baseUrl);
    if (!absolute) return match;
    return `${name}="${proxyPath(id, absolute)}"`;
  });
}

/**
 * Rewrite an HLS playlist body, preserving the source line endings and every
 * tag/comment that does not carry a URI attribute.
 *
 * @param {string} body
 * @param {string} baseUrl original (resolved) playlist URL
 * @param {number|string} id
 * @returns {string}
 */
export function rewritePlaylistBody(body, baseUrl, id) {
  const parts = String(body).split(/(\r\n|\n|\r)/);
  let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    const eol = parts[i + 1] ?? '';
    const trimmed = line.trim();

    let rewritten = line;
    if (trimmed.startsWith('#')) {
      rewritten = rewriteTagUris(line, baseUrl, id);
    } else if (trimmed.length > 0) {
      const absolute = absoluteUpstreamUrl(trimmed, baseUrl);
      rewritten = absolute ? proxyPath(id, absolute) : line;
    }
    out += rewritten + eol;
  }
  return out;
}

function isId(value) {
  const raw = String(value ?? '');
  return /^\d{1,10}$/.test(raw) && Number.isSafeInteger(Number(raw));
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

/**
 * Reply 502 for an unresolvable id. Only the first attempt for an id logs a
 * warning; retries inside the negative-cache window stay at debug level so a
 * player that hammers a dead channel cannot flood the log.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string|number} id
 * @param {unknown} err
 */
function unavailable(res, id, err) {
  const reason = (err && (err.reason || err.name)) || 'unknown';
  if (err && err.cachedFailure) {
    log.debug('hls: resolve throttled', { id, reason });
  } else {
    log.warn('hls: resolve failed', { id, reason });
  }
  const headers = {};
  const retryAfterMs = err && Number(err.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }
  return sendText(res, 502, 'stream unavailable\n', headers);
}

function sendText(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = String(body);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

async function resolveCached(id) {
  const key = `${RESOLVE_PREFIX}${id}:`;
  return cache.get(key, RESOLVE_TTL_MS, async () => {
    const result = await resolveProvider(id);
    if (!result || typeof result.url !== 'string') {
      throw new Error('provider returned no stream URL');
    }
    rememberResolvedUrl(result.url);
    return result;
  });
}

async function reresolve(id) {
  cache.invalidate(`${RESOLVE_PREFIX}${id}:`);
  invalidateProvider(id);
  return resolveCached(id);
}

async function fetchPlaylistText(id, resolution) {
  const attempt = (subject) =>
    fetchText(subject.url, { headers: subject.headers, retries: 1 });

  try {
    return { body: await attempt(resolution), resolution };
  } catch (err) {
    const status = err && err.status;
    if (err instanceof UpstreamError && (status === 403 || status === 404)) {
      log.warn('hls: playlist rejected, re-resolving', { id, status });
      const fresh = await reresolve(id);
      return { body: await attempt(fresh), resolution: fresh };
    }
    throw err;
  }
}

/**
 * GET /stream/:id.m3u8
 *
 * @param {number|string} id
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function proxyPlaylist(id, req, res) {
  if (!isId(id)) return sendText(res, 400, 'bad request\n');

  let resolution;
  try {
    resolution = await resolveCached(id);
  } catch (err) {
    return unavailable(res, id, err);
  }

  let body;
  try {
    const result = await fetchPlaylistText(id, resolution);
    body = result.body;
    resolution = result.resolution;
  } catch (err) {
    log.warn('hls: playlist fetch failed', {
      id,
      status: err && err.status,
      code: (err && err.code) || undefined,
    });
    return sendText(res, 502, 'upstream playlist unavailable\n');
  }

  const head = String(body).replace(/^\uFEFF/, '').trimStart();
  if (!head.startsWith('#EXTM3U')) {
    log.warn('hls: upstream body is not a playlist', { id });
    return sendText(res, 502, 'invalid upstream playlist\n');
  }

  const rewritten = rewritePlaylistBody(body, resolution.url, id);
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Content-Length': Buffer.byteLength(rewritten),
    'Cache-Control': PLAYLIST_CACHE_CONTROL,
  });
  res.end(rewritten);
}

class ProxyFetchError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'ProxyFetchError';
    this.statusCode = statusCode;
  }
}

function segmentRequestHeaders(resolution, req) {
  const headers = {
    'user-agent': config.userAgent,
    accept: '*/*',
    'accept-encoding': 'identity',
    ...(resolution && resolution.headers ? resolution.headers : {}),
  };
  const range = req.headers.range;
  if (typeof range === 'string') headers.range = range;
  const ifRange = req.headers['if-range'];
  if (typeof ifRange === 'string') headers['if-range'] = ifRange;
  return headers;
}

/**
 * Fetch a segment, following only redirects that stay on https + allowlisted
 * hosts. Returns the live Response so the caller can stream it through.
 */
async function fetchSegment(url, headers) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (err) {
      throw new ProxyFetchError(`segment request failed (${err.code || err.name})`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelBody(response);
      if (!location) throw new ProxyFetchError('upstream redirect without location');
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new ProxyFetchError('invalid upstream redirect');
      }
      if (next.protocol !== 'https:' || !hostAllowed(next.hostname)) {
        throw new ProxyFetchError('upstream redirect to a non-allowlisted host', 403);
      }
      current = next.toString();
      continue;
    }
    return response;
  }
  throw new ProxyFetchError('too many upstream redirects');
}

/**
 * GET /seg/:id/:token
 *
 * @param {number|string} id
 * @param {string} token base64url(absolute upstream URL)
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function proxySegment(id, token, req, res) {
  if (!isId(id)) return sendText(res, 400, 'bad request\n');

  const target = decodeSegmentToken(token);
  if (!target) return sendText(res, 403, 'forbidden\n');

  let resolution;
  try {
    resolution = await resolveCached(id);
  } catch (err) {
    return unavailable(res, id, err);
  }

  let response;
  try {
    response = await fetchSegment(target.toString(), segmentRequestHeaders(resolution, req));
  } catch (err) {
    const status = err && err.statusCode === 403 ? 403 : 502;
    return sendText(res, status, status === 403 ? 'forbidden\n' : 'upstream error\n');
  }

  if (response.status === 403 || response.status === 404) {
    await cancelBody(response);
    log.warn('hls: segment rejected, re-resolving', { id, status: response.status });
    try {
      resolution = await reresolve(id);
      response = await fetchSegment(
        target.toString(),
        segmentRequestHeaders(resolution, req),
      );
    } catch (err) {
      const status = err && err.statusCode === 403 ? 403 : 502;
      return sendText(res, status, status === 403 ? 'forbidden\n' : 'upstream error\n');
    }
  }

  if (!response.ok) {
    const status = response.status;
    await cancelBody(response);
    log.warn('hls: segment upstream error', { id, status });
    return sendText(res, 502, 'upstream error\n');
  }

  const headers = { 'Cache-Control': SEGMENT_CACHE_CONTROL };
  const contentType = response.headers.get('content-type');
  headers['Content-Type'] = contentType || 'application/octet-stream';
  for (const [source, destination] of [
    ['content-length', 'Content-Length'],
    ['content-range', 'Content-Range'],
    ['accept-ranges', 'Accept-Ranges'],
  ]) {
    const value = response.headers.get(source);
    if (value !== null) headers[destination] = value;
  }

  if (res.headersSent || res.destroyed) {
    await cancelBody(response);
    return;
  }

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (err) {
    // Client went away (or the upstream stream broke); nothing useful to say.
    log.debug('hls: segment stream ended', { id, reason: err && err.name });
    if (!res.destroyed) res.destroy();
  }
}

export default {
  proxyPlaylist,
  proxySegment,
  rewritePlaylistBody,
  encodeSegmentToken,
  decodeSegmentToken,
  isAllowedHost,
  rememberResolvedUrl,
};
