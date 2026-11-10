/**
 * M3U playlist generation from the catalogue snapshot.
 *
 * Pure functions: no I/O and no knowledge of the HTTP request beyond the
 * `baseUrl` used to build absolute links. The server owns caching/ETags.
 */

import { config } from '../config.js';

export const PLAYLIST_MODES = Object.freeze(['all', 'channels', 'events', 'live']);

const CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/** Events that ended longer ago than this are dead streams and are skipped. */
const EVENT_STALE_MS = 6 * 60 * 60 * 1000;

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attribute values live inside double quotes, so quotes become apostrophes. */
function attr(value) {
  return cleanText(value).replace(/"/g, "'");
}

/** Display names may contain commas but never line breaks. */
function displayName(value) {
  return cleanText(value);
}

function channelId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function normaliseMode(mode) {
  const value = String(mode ?? 'all').trim().toLowerCase() || 'all';
  if (!PLAYLIST_MODES.includes(value)) {
    throw new RangeError(`unknown playlist mode ${JSON.stringify(mode)}`);
  }
  return value;
}

function normaliseWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return config.eventWindowMin;
  return Math.min(10_080, n);
}

/**
 * Validate a `Host` header so it cannot inject markup or extra lines into the
 * generated playlist. Returns null for anything that is not host[:port].
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function sanitizeHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim();
  if (!host || host.length > 255) return null;
  if (/[\s"'<>\u0000-\u001f\\/]/.test(host)) return null;

  // Bracketed IPv6 literal, optionally with a port.
  if (host.startsWith('[')) {
    const match = host.match(/^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/);
    if (!match) return null;
    if (match[2] !== undefined) {
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    }
    return host;
  }

  const match = host.match(/^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) return null;
  const hostname = match[1];
  if (hostname.length > 253) return null;
  for (const label of hostname.split('.')) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return null;
  }
  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return host;
}

function forwardedProto(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0].trim().toLowerCase();
  return first === 'http' || first === 'https' ? first : null;
}

function fallbackHost(req) {
  const port = req && req.socket ? req.socket.localPort : undefined;
  return port ? `localhost:${port}` : 'localhost';
}

/**
 * Derive the externally visible base URL for playlist links.
 *
 * `config.baseUrl` wins when set; otherwise use the (sanitised) Host header
 * and X-Forwarded-Proto, falling back to the local socket address.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function resolveBaseUrl(req) {
  if (config.baseUrl) return config.baseUrl;
  const headers = (req && req.headers) || {};
  const host = sanitizeHost(headers.host) ?? fallbackHost(req);
  const proto = forwardedProto(headers['x-forwarded-proto'])
    ?? (req && req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function normaliseBaseUrl(value) {
  if (!value) return '';
  const raw = String(value).trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return raw;
  } catch {
    return '';
  }
}

function urlFor(baseUrl, path) {
  return baseUrl ? `${baseUrl}${path}` : path;
}

function compareChannels(a, b) {
  return (
    String(a.group ?? '').localeCompare(String(b.group ?? ''), 'en', { sensitivity: 'base' }) ||
    String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', { sensitivity: 'base' }) ||
    Number(a.id) - Number(b.id)
  );
}

function compareEvents(a, b) {
  return (
    Number(a.startMs) - Number(b.startMs) ||
    String(a.title ?? '').localeCompare(String(b.title ?? ''), 'en', { sensitivity: 'base' }) ||
    Number(a.id) - Number(b.id)
  );
}

function validEvent(event) {
  return (
    event &&
    Number.isFinite(Number(event.startMs)) &&
    Number.isFinite(Number(event.endMs)) &&
    Number(event.endMs) > Number(event.startMs) &&
    Array.isArray(event.channelIds)
  );
}

/**
 * Playable channel targets for an event, keeping names aligned with ids.
 * Id 0 is the site's placeholder link (`/watch.php?id=00`) and never plays.
 */
function eventChannels(event) {
  const out = [];
  const rawIds = Array.isArray(event?.channelIds) ? event.channelIds : [];
  const rawNames = Array.isArray(event?.channelNames) ? event.channelNames : [];
  for (let i = 0; i < rawIds.length; i++) {
    const id = channelId(rawIds[i]);
    if (id === null || id <= 0) continue;
    if (out.some((entry) => entry.id === id)) continue;
    out.push({ id, name: displayName(rawNames[i]) });
  }
  return out;
}

function playlistEventSelected(event, mode, now, windowMs, includeFuture) {
  const start = Number(event.startMs);
  const end = Number(event.endMs);
  if (mode === 'live') {
    const live = start - windowMs <= now && end > now;
    if (live) return true;
    return includeFuture && start > now;
  }
  // all/events: the whole upcoming schedule plus anything that ended within
  // the grace window; long-finished events are dead streams, so drop them.
  return end > now - EVENT_STALE_MS;
}

/**
 * Build an M3U playlist.
 *
 * @param {{
 *   channels?: Array<{id:number,name:string,group:string}>,
 *   events?: Array<object>,
 *   mode?: 'all'|'channels'|'events'|'live',
 *   windowMin?: number,
 *   includeFuture?: boolean,
 *   limit?: number,
 *   baseUrl?: string,
 *   nowMs?: number,
 * }} [options]
 * @returns {{body:string, contentType:string, count:number}}
 */
export function buildPlaylist(options = {}) {
  const channels = Array.isArray(options.channels) ? options.channels : [];
  const excluded = new Set(
    (Array.isArray(options.excludeChannelIds) ? options.excludeChannelIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value)),
  );
  const events = Array.isArray(options.events) ? options.events : [];
  const mode = normaliseMode(options.mode);
  const windowMs = normaliseWindow(options.windowMin) * 60_000;
  const includeFuture = Boolean(options.includeFuture);
  const now = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rawLimit = Number(options.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 0;
  const baseUrl = normaliseBaseUrl(options.baseUrl);

  const entries = [];
  const seen = new Set();

  if (mode === 'all' || mode === 'channels') {
    for (const channel of [...channels].sort(compareChannels)) {
      if (!channel) continue;
      const id = channelId(channel.id);
      if (id === null || excluded.has(id)) continue;
      const tvgId = `dlhd-${id}`;
      if (seen.has(tvgId)) continue;
      seen.add(tvgId);

      const name = displayName(channel.name) || `Channel ${id}`;
      const group = displayName(channel.group) || '#';
      entries.push({
        line:
          `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${attr(name)}" tvg-logo="" ` +
          `group-title="24/7 | ${attr(group)}",${name}`,
        url: urlFor(baseUrl, `/stream/${id}.m3u8`),
      });
    }
  }

  if (mode !== 'channels') {
    for (const event of [...events].filter(validEvent).sort(compareEvents)) {
      if (!playlistEventSelected(event, mode, now, windowMs, includeFuture)) continue;
      const id = Number(event.id);
      if (!Number.isInteger(id) || id < 0) continue;
      const targets = eventChannels(event).filter((target) => !excluded.has(target.id));
      if (targets.length === 0) continue; // no playable channel
      const ids = targets.map((target) => target.id);
      const tvgId = `dlhd-ev-${id}`;
      if (seen.has(tvgId)) continue;
      seen.add(tvgId);

      let name = displayName(event.title);
      if (!name) name = `Event ${id}`;
      if (targets.length > 1) {
        const names = targets.map((target) => target.name).filter(Boolean);
        if (names.length > 0) name = `${name} [${names.join(', ')}]`;
      }
      const category = displayName(event.category) || 'Events';
      entries.push({
        line:
          `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${attr(name)}" tvg-logo="" ` +
          `group-title="Live | ${attr(category)}",${name}`,
        url: urlFor(baseUrl, `/stream/${ids[0]}.m3u8`),
      });
    }
  }

  const selected = limit > 0 ? entries.slice(0, limit) : entries;
  const header = baseUrl
    ? `#EXTM3U x-tvg-url="${baseUrl}/xmltv.xml"`
    : '#EXTM3U';

  const lines = [header];
  for (const entry of selected) lines.push(entry.line, entry.url);
  const body = `${lines.join('\n')}\n`;

  return { body, contentType: CONTENT_TYPE, count: selected.length };
}

export default { buildPlaylist, resolveBaseUrl, sanitizeHost, PLAYLIST_MODES };
