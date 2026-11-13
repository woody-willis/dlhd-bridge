/**
 * External XMLTV guide: fetch, parse, match onto the catalogue, keep in memory.
 *
 * Sources are loaded one at a time and parsed in two passes over the same
 * document: channels first, then only the programmes whose channel matched the
 * catalogue. The decompressed bytes and the per-source arrays are released
 * before the next fetch, so peak memory stays close to one source at a time.
 * Matching is against the current catalogue snapshot. The background loop is
 * stale-on-error: a failed refresh keeps the previous guide.
 */

import { gunzipSync } from 'node:zlib';

import { config } from '../config.js';
import { fetchStream } from '../http.js';
import * as log from '../log.js';
import { getChannels } from '../catalog/index.js';
import { parseXmltvChannels, parseProgrammes } from './parse.js';
import { matchChannels } from './match.js';

const GZIP_MAGIC = [0x1f, 0x8b];

/** Shape exposed by getGuide(). Mutated in place so references stay stable. */
const guide = {
  byChannelId: new Map(),
  fetchedAt: 0,
  matched: 0,
  programmes: 0,
  errors: [],
  sources: [],
};

let revision = 0;
let inflight = null;
let timer = null;
let epgChannelCount = 0;

function readCapped(res, limit) {
  if (!res.body) return Promise.resolve(Buffer.alloc(0));
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;

  return (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          throw new Error(`epg body exceeds EPG_MAX_BYTES (${limit} bytes)`);
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock?.();
    }
  })();
}

function looksLikeXml(buffer) {
  return buffer.length > 0 && (buffer[0] === 0x3c || buffer[0] === 0xfe || buffer[0] === 0xff);
}

/**
 * Decompress when needed and return the XML bytes.
 *
 * The parser scans bytes directly, so the document is never expanded into a JS
 * string: a 78 MB source would otherwise cost another 78-156 MB as UTF-8/
 * UTF-16 text. The output chunk is sized from the gzip trailer so zlib hands
 * back one right-sized buffer instead of copying a chunk list.
 */
function decodeXml(buffer, url) {
  const gzipped =
    buffer.length > 1 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1];
  if (gzipped || /\.gz(?:$|[?#])/i.test(url)) {
    try {
      // The gzip trailer holds the uncompressed size. Sizing the zlib output
      // chunk just above it makes the sync path return a single buffer of the
      // document's size (instead of reserving EPG_MAX_BYTES for every source,
      // including the small ones). A multi-member gzip simply grows to more
      // chunks. The slack keeps the output from exactly filling the chunk,
      // which would force zlib to allocate and concatenate a second one.
      const isize = buffer.length >= 18 ? buffer.readUInt32LE(buffer.length - 4) : 0;
      const chunkSize =
        isize > 0 && isize + 4096 < config.epgMaxBytes ? isize + 4096 : config.epgMaxBytes;
      return gunzipSync(buffer, {
        chunkSize,
        maxOutputLength: config.epgMaxBytes,
      });
    } catch (err) {
      if (!gzipped && looksLikeXml(buffer)) return buffer;
      throw err;
    }
  }
  return buffer;
}

/** Fetch one source and return its XML bytes, enforcing the size budget. */
async function loadSource(url) {
  const res = await fetchStream(url, {
    headers: { accept: 'application/gzip, application/xml, text/xml, */*' },
    retries: 1,
    timeoutMs: config.upstreamTimeoutMs,
  });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > config.epgMaxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`epg body too large (${declared} bytes)`);
  }
  const buffer = await readCapped(res, config.epgMaxBytes);
  return decodeXml(buffer, url);
}

/**
 * Match the source channels onto ours once, and derive the compact lookup the
 * programme pass needs (EPG id -> our id, plus icons for matched channels).
 */
function planSource(ourChannels, epgChannels) {
  const { mapping, stats } = matchChannels(ourChannels, epgChannels);
  const epgToOur = new Map();
  for (const [ourId, epgId] of mapping) {
    if (!epgToOur.has(epgId)) epgToOur.set(epgId, ourId);
  }
  const icons = new Map();
  for (const channel of epgChannels) {
    if (epgToOur.has(channel.id)) icons.set(channel.id, channel.icon);
  }
  return { mapping, stats, epgToOur, icons };
}

/**
 * Keep only guide entries for our channels. Programmes are sorted and
 * de-duplicated by start time here so the XMLTV generator never has to
 * traverse the full source.
 */
function mergeParsed(plan, programmeList) {
  const { mapping, stats, epgToOur, icons } = plan;
  const byChannelId = new Map();
  let programmes = 0;

  for (const programme of programmeList) {
    const ourId = epgToOur.get(programme.channel);
    if (ourId === undefined) continue;
    let entry = byChannelId.get(ourId);
    if (!entry) {
      entry = {
        programmes: [],
        icon: icons.get(programme.channel) ?? '',
        sourceChannelId: programme.channel,
      };
      byChannelId.set(ourId, entry);
    }
    entry.programmes.push(programme);
    programmes++;
  }

  for (const entry of byChannelId.values()) {
    entry.programmes.sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
    const seen = new Set();
    entry.programmes = entry.programmes.filter((programme) => {
      if (seen.has(programme.startMs)) return false;
      seen.add(programme.startMs);
      return true;
    });
  }

  return { byChannelId, matched: mapping.size, programmes, matchStats: stats };
}

function result() {
  return {
    channels: epgChannelCount,
    programmes: guide.programmes,
    matched: guide.matched,
    sources: guide.sources,
    fetchedAt: guide.fetchedAt,
    errors: guide.errors,
    revision,
  };
}

async function doRefresh(options) {
  const sources = Array.isArray(options.sources) ? options.sources : config.epgSources;
  const ourChannels = Array.isArray(options.channels) ? options.channels : getChannels();
  const load = typeof options.loadSource === 'function' ? options.loadSource : loadSource;

  if (sources.length === 0) {
    log.info('epg: disabled (EPG_SOURCES=none)');
    return result();
  }

  const startedAt = Date.now();
  const merged = new Map();
  const sourceStats = [];
  const errors = [];
  let matched = 0;
  let programmes = 0;
  let channels = 0;
  let ok = false;

  for (const url of sources) {
    // Everything derived from one source stays scoped to this iteration and is
    // dropped before the next fetch, so only the merged guide survives.
    let document = null;
    let plan = null;
    let programmePass = null;
    try {
      document = await load(url);
      // Pass 1: channels only. Match them, then pass 2 keeps just the
      // programmes for the small set of EPG ids that belong to our catalogue.
      const channelPass = parseXmltvChannels(document);
      const sourceChannels = channelPass.stats.channels;
      plan = planSource(ourChannels, channelPass.channels);
      // Release the channel objects; only `plan` is needed from here on.
      channelPass.channels.length = 0;
      const wanted = plan.epgToOur;
      programmePass = parseProgrammes(document, wanted.keys());
      document = null;

      const partial = mergeParsed(plan, programmePass.programmes);
      for (const [id, entry] of partial.byChannelId) {
        if (!merged.has(id)) merged.set(id, entry);
      }
      channels += sourceChannels;
      ok = true;
      sourceStats.push({
        url,
        channels: sourceChannels,
        programmes: programmePass.stats.programmes,
      });
      log.info('epg: source loaded', {
        url,
        channels: sourceChannels,
        programmes: programmePass.stats.programmes,
        ignored: programmePass.stats.ignoredProgrammes,
        matched: partial.matched,
        withGuide: partial.byChannelId.size,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      sourceStats.push({ url, channels: 0, programmes: 0, error: message });
      errors.push({ message });
      log.warn('epg: source failed, keeping previous guide for it', { url, err: message });
    } finally {
      // Release the decompressed document and the temporary arrays before the
      // next fetch; the kept guide references only copied strings and objects.
      document = null;
      plan = null;
      if (programmePass) {
        programmePass.programmes.length = 0;
        programmePass = null;
      }
    }
  }

  if (ok) {
    for (const entry of merged.values()) programmes += entry.programmes.length;
    matched = merged.size;
    guide.byChannelId = merged;
    guide.matched = matched;
    guide.programmes = programmes;
    guide.fetchedAt = Date.now();
    epgChannelCount = channels;
    revision++;
    log.info('epg: guide updated', {
      matched,
      programmes,
      sources: sourceStats.length,
      ms: guide.fetchedAt - startedAt,
    });
  } else {
    log.warn('epg: all sources failed', { errors: errors.length });
  }

  guide.errors = errors;
  guide.sources = sourceStats;
  return result();
}

/**
 * Refresh now (single-flight). Never rejects; failures are recorded in
 * `errors` and the previous guide is kept.
 *
 * @param {{sources?: string[], channels?: Array, loadSource?: (url:string)=>Promise<string>}} [options]
 *   Test/advanced overrides; normally the config and catalogue are used.
 */
export function refreshNow(options = {}) {
  if (inflight) return inflight;
  inflight = doRefresh(options)
    .catch((err) => {
      guide.errors = [
        ...guide.errors,
        { message: err && err.message ? err.message : String(err) },
      ];
      log.error('epg: refresh crashed', err);
      return result();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The current guide. Treat as read-only; do not keep the Map across refreshes. */
export function getGuide() {
  return guide;
}

/** Small summary for /healthz; never includes source URLs. */
export function getStats() {
  return {
    enabled: config.epgSources.length > 0,
    fetchedAt: guide.fetchedAt,
    ageMs: guide.fetchedAt ? Date.now() - guide.fetchedAt : null,
    matched: guide.matched,
    programmes: guide.programmes,
    sources: guide.sources.length,
    errors: guide.errors.length,
    refreshing: inflight !== null,
    revision,
  };
}

/** Increments whenever the guide data is replaced (cache key / ETag input). */
export function epgRevision() {
  return revision;
}

/**
 * Start the background refresh loop (initial load included). Safe to call more
 * than once; the returned promise never rejects.
 */
export function startEpgRefresh() {
  if (!timer && config.epgSources.length > 0) {
    timer = setInterval(() => {
      refreshNow().catch(() => {});
    }, config.epgRefreshMin * 60_000);
    if (typeof timer.unref === 'function') timer.unref();
    log.info('epg: refresh loop started', {
      everyMin: config.epgRefreshMin,
      sources: config.epgSources.length,
    });
  }
  return refreshNow();
}

export default {
  getGuide,
  getStats,
  epgRevision,
  refreshNow,
  startEpgRefresh,
};
