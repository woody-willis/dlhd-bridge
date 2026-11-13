/**
 * HTTP surface: status page, playlist, XMLTV and the HLS proxy routes.
 *
 * All request handling is defensive: unknown paths are JSON 404s, wrong
 * methods are 405s, malformed URLs are rejected before routing, and no error
 * response ever contains a stack trace or an upstream URL.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';

import { config } from '../config.js';
import * as log from '../log.js';
import { getChannels, getEvents, getStats } from '../catalog/index.js';
import { getGuide, getStats as epgStats, epgRevision } from '../epg/index.js';
import {
  stats as providerStats,
  unplayableIds,
  unplayableKey,
} from '../providers/index.js';
import { buildPlaylist, resolveBaseUrl, PLAYLIST_MODES } from './playlist.js';
import { buildXmltv } from './xmltv.js';
import { proxyPlaylist, proxySegment } from './hls.js';
import * as cache from './cache.js';

const MAX_URL_LENGTH = 4096;
const SOCKET_TIMEOUT_MS = 10_000;
const PLAYLIST_MAX_AGE = 30;
const XMLTV_MAX_AGE = 300;
const PLAYLIST_TTL_MS = PLAYLIST_MAX_AGE * 1000;
const XMLTV_TTL_MS = XMLTV_MAX_AGE * 1000;

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}

function weakEtag(...parts) {
  const hash = createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}

function opaqueTag(value) {
  return String(value ?? '').trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1');
}

function etagMatches(header, etag) {
  if (!header) return false;
  const raw = String(header).trim();
  if (raw === '*') return true;
  const target = opaqueTag(etag);
  return raw.split(',').some((part) => opaqueTag(part) === target);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function sendJson(res, status, payload, extraHeaders = {}, head = false) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(head ? undefined : body);
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

const ENDPOINTS = Object.freeze([
  ['GET /', 'status page'],
  ['GET /healthz', 'health + counts (JSON)'],
  ['GET /playlist.m3u', 'playlist (mode=all|channels|events|live)'],
  ['GET /playlist.m3u8', 'playlist alias'],
  ['GET /xmltv.xml', 'XMLTV guide'],
  ['GET /epg.xml', 'XMLTV alias'],
  ['GET /stream/:id.m3u8', 'rewritten HLS playlist'],
  ['GET /seg/:id/:token', 'segment passthrough'],
]);

function renderStatusPage() {
  const stats = getStats();
  const providers = providerStats();
  const epg = epgStats();
  const uptime = formatUptime(process.uptime());
  const fetched = stats.fetchedAt ? new Date(stats.fetchedAt).toISOString() : 'never';
  const epgFetched = epg.fetchedAt ? new Date(epg.fetchedAt).toISOString() : 'never';
  const rows = [
    ['Channels', stats.channels],
    ['Events', stats.events],
    ['Resolved streams', providers.resolved],
    ['Uptime', uptime],
    ['Catalogue fetched', fetched],
    ['Guide programmes', epg.programmes],
    ['Guide channels matched', epg.matched],
    ['Guide fetched', epgFetched],
    ['Refresh errors', stats.errors.length],
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('');
  const endpoints = ENDPOINTS.map(
    ([route, description]) =>
      `<li><code>${escapeHtml(route)}</code> <span>${escapeHtml(description)}</span></li>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dlhd-bridge</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}
h1{font-size:1.4rem;margin:0 0 1rem}
table{border-collapse:collapse;margin:0 0 1.5rem}
th,td{text-align:left;padding:.2rem .9rem .2rem 0;font-weight:400}
th{color:#666}
ul{padding-left:1.1rem}
code{background:#eee;padding:.05rem .3rem;border-radius:3px}
span{color:#555}
</style>
</head>
<body>
<h1>dlhd-bridge</h1>
<table>${rows}</table>
<h2>Endpoints</h2>
<ul>${endpoints}</ul>
</body>
</html>
`;
}

function positiveInt(value, name, { min, max }) {
  if (!/^\d+$/.test(value)) throw new BadRequest(`${name} must be an integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new BadRequest(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

function optionalInt(searchParams, name, { min, max, fallback }) {
  if (!searchParams.has(name)) return fallback;
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  return positiveInt(raw, name, { min, max });
}

function parsePlaylistParams(searchParams) {
  const mode = String(searchParams.get('mode') ?? 'all').trim().toLowerCase() || 'all';
  if (!PLAYLIST_MODES.includes(mode)) {
    throw new BadRequest(`mode must be one of ${PLAYLIST_MODES.join(', ')}`);
  }

  const windowMin = optionalInt(searchParams, 'window', {
    min: 0,
    max: 10_080,
    fallback: config.eventWindowMin,
  });
  const limit = optionalInt(searchParams, 'limit', {
    min: 1,
    max: 100_000,
    fallback: 0,
  });

  let includeFuture = false;
  if (searchParams.has('include_future')) {
    const raw = String(searchParams.get('include_future')).trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(raw)) includeFuture = true;
    else if (!['', '0', 'false', 'no'].includes(raw)) {
      throw new BadRequest('include_future must be 0 or 1');
    }
  }

  return { mode, windowMin, limit, includeFuture };
}

async function handleStatus(res, head) {
  const body = renderStatusPage();
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : body);
}

function handleHealth(res, head) {
  const stats = getStats();
  const providers = providerStats();
  const epg = epgStats();
  sendJson(
    res,
    200,
    {
      ok: stats.fetchedAt > 0,
      channels: stats.channels,
      events: stats.events,
      resolved: providers.resolved,
      uptime: Math.round(process.uptime()),
      epg: {
        matched: epg.matched,
        programmes: epg.programmes,
        sources: epg.sources,
        ageMs: epg.ageMs,
      },
    },
    {},
    head,
  );
}

async function handlePlaylist(req, res, url, head) {
  let params;
  try {
    params = parsePlaylistParams(url.searchParams);
  } catch (err) {
    if (err instanceof BadRequest) {
      return sendJson(res, 400, { error: 'bad_request', message: err.message }, {}, head);
    }
    throw err;
  }

  const baseUrl = resolveBaseUrl(req);
  const stats = getStats();
  // Ids proven to live on a player we cannot script are hidden from the
  // playlist until their backoff window expires, so Jellyfin stops offering
  // streams that can only 502.
  const deadIds = unplayableIds();
  const deadKey = unplayableKey();
  const key =
    `playlist:${stats.fetchedAt}:${params.mode}:${params.windowMin}:` +
    `${params.includeFuture ? 1 : 0}:${params.limit}:${baseUrl}:${deadKey}`;

  const generated = await cache.get(key, PLAYLIST_TTL_MS, () =>
    buildPlaylist({
      channels: getChannels(),
      events: getEvents(),
      mode: params.mode,
      windowMin: params.windowMin,
      includeFuture: params.includeFuture,
      limit: params.limit,
      baseUrl,
      excludeChannelIds: deadIds,
    }),
  );

  const etag = weakEtag(
    'playlist',
    stats.fetchedAt,
    params.mode,
    params.windowMin,
    params.includeFuture ? 1 : 0,
    params.limit,
    baseUrl,
    deadKey,
  );
  const headers = {
    'Content-Type': generated.contentType,
    'Cache-Control': `public, max-age=${PLAYLIST_MAX_AGE}`,
    ETag: etag,
  };

  if (etagMatches(req.headers['if-none-match'], etag)) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = Buffer.byteLength(generated.body);
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, headers);
  res.end(head ? undefined : generated.body);
}

async function handleXmltv(req, res, head) {
  const stats = getStats();
  // Same dead-id filter as the playlist so the guide never advertises a
  // channel that has no working stream entry.
  const deadIds = unplayableIds();
  const deadKey = unplayableKey();
  const revision = epgRevision();
  const key = `xmltv:${stats.fetchedAt}:${deadKey}:${revision}`;

  const generated = await cache.get(key, XMLTV_TTL_MS, () =>
    buildXmltv({
      channels: getChannels(),
      events: getEvents(),
      nowMs: Date.now(),
      excludeChannelIds: deadIds,
      guide: getGuide(),
    }),
  );

  const etag = weakEtag('xmltv', stats.fetchedAt, deadKey, revision);
  const headers = {
    'Content-Type': generated.contentType,
    'Cache-Control': `public, max-age=${XMLTV_MAX_AGE}`,
    ETag: etag,
  };
  if (generated.truncated) {
    headers['X-Programmes-Truncated'] = '1';
    log.warn('xmltv: programme cap reached', { programmes: generated.programmes });
  }

  if (etagMatches(req.headers['if-none-match'], etag)) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = Buffer.byteLength(generated.body);
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, headers);
  res.end(head ? undefined : generated.body);
}

function matchRoute(pathname) {
  if (pathname === '/') return { name: 'status', methods: ['GET', 'HEAD'] };
  if (pathname === '/healthz') return { name: 'health', methods: ['GET', 'HEAD'] };
  if (pathname === '/playlist.m3u' || pathname === '/playlist.m3u8') {
    return { name: 'playlist', methods: ['GET', 'HEAD'] };
  }
  if (pathname === '/xmltv.xml' || pathname === '/epg.xml') {
    return { name: 'xmltv', methods: ['GET', 'HEAD'] };
  }

  const stream = pathname.match(/^\/stream\/(\d{1,10})\.m3u8$/);
  if (stream) return { name: 'stream', id: stream[1], methods: ['GET'] };

  const segment = pathname.match(/^\/seg\/(\d{1,10})\/([A-Za-z0-9_.-]{1,4100})$/);
  if (segment) {
    return { name: 'segment', id: segment[1], token: segment[2], methods: ['GET'] };
  }

  return null;
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  const method = String(req.method || 'GET').toUpperCase();
  let pathname = '<invalid>';
  let logged = false;

  const noteRequest = (status) => {
    if (logged) return;
    logged = true;
    log.debug('http request', {
      method,
      path: pathname,
      status,
      ms: Date.now() - startedAt,
    });
  };
  res.on('finish', () => noteRequest(res.statusCode));
  res.on('close', () => {
    if (!res.writableFinished) noteRequest(0);
  });

  const rawUrl = req.url || '/';
  if (rawUrl.length > MAX_URL_LENGTH) {
    pathname = '<too-long>';
    return sendJson(res, 414, { error: 'uri_too_long' });
  }

  let url;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad_request', message: 'invalid URL' });
  }
  pathname = url.pathname;

  const route = matchRoute(pathname);
  if (!route) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  if (!route.methods.includes(method)) {
    return sendJson(
      res,
      405,
      { error: 'method_not_allowed' },
      { Allow: route.methods.join(', ') },
    );
  }

  const head = method === 'HEAD';
  switch (route.name) {
    case 'status':
      return handleStatus(res, head);
    case 'health':
      return handleHealth(res, head);
    case 'playlist':
      return handlePlaylist(req, res, url, head);
    case 'xmltv':
      return handleXmltv(req, res, head);
    case 'stream':
      return proxyPlaylist(route.id, req, res);
    case 'segment':
      return proxySegment(route.id, route.token, req, res);
    default:
      return sendJson(res, 404, { error: 'not_found' });
  }
}

/**
 * Create the configured HTTP server (not yet listening).
 * @returns {import('node:http').Server}
 */
export function createServer() {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error('http request crashed', {
        method: req.method,
        err: err && err.name,
        message: err && err.message,
      });
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: 'internal_error' });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
  });

  server.setTimeout(SOCKET_TIMEOUT_MS, (socket) => {
    log.debug('http: socket timeout');
    socket.destroy();
  });
  server.maxHeadersCount = 100;

  server.on('clientError', (err, socket) => {
    // Malformed request lines (a TLS handshake on the plain port, port scans,
    // aborted uploads) are routine noise, not something an operator can act
    // on. Keep them visible at debug level only.
    const code = (err && err.code) || '';
    const benign = /^(HPE_INVALID_METHOD|HPE_INVALID_URL|HPE_INVALID_EOF_STATE|HPE_INVALID_HEADER_TOKEN|ECONNRESET|EPIPE)$/.test(code);
    if (benign) log.debug('http client error', { code });
    else log.warn('http client error', { code });
    if (!socket.destroyed && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  return server;
}

export default { createServer };
