/**
 * In-memory catalogue snapshot with background refresh.
 *
 * The site is scraped on a timer (CATALOG_REFRESH_MIN) and served from memory
 * so playlist/XMLTV requests never hit upstream. Refreshes are single-flight;
 * a failed refresh serves the previous good snapshot (stale-on-error) and
 * records the failure for /healthz.
 */

import { config, SITE } from '../config.js';
import { fetchText } from '../http.js';
import * as log from '../log.js';
import { parseChannels, parseEvents } from './scrape.js';

/**
 * Adult / 18+ detection. Deliberately narrow: it must catch the site's
 * "18+ (Player-01..20)" block without touching ordinary channels such as
 * "Adult Swim". EXCLUDE_ADULT=0 turns the filter off entirely.
 */
const ADULT_PATTERNS = Object.freeze([
  /\b18\s*\+/i,
  /\bxxx\b/i,
  /\badult\b(?!\s*swim)/i,
  /\bplayboy\b/i,
  /\bhustler\b/i,
  /\bpenthouse\b/i,
  /\bbrazzers\b/i,
  /\bdorcel\b/i,
  /\breality\s*kings\b/i,
  /\bevil\s*angel\b/i,
  /\bxmo\b/i,
  /\bvivid\b/i,
  /\berotic\b/i,
  /\bbarely\s*legal\b/i,
  /\bexxotica\b/i,
  /\bredlight\b/i,
]);

/**
 * @param {unknown} value channel name or event title
 * @returns {boolean}
 */
export function isAdultText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  return ADULT_PATTERNS.some((re) => re.test(text));
}

/** @typedef {{channels:Array,events:Array,fetchedAt:number,errors:Array,stats:Object}} Snapshot */

/** @type {Snapshot} */
const snapshot = {
  channels: [],
  events: [],
  fetchedAt: 0,
  errors: [],
  stats: {
    channelCards: 0,
    channelDuplicates: 0,
    channelInvalid: 0,
    eventBlocks: 0,
    eventSkipped: 0,
    channelAdult: 0,
    eventAdult: 0,
  },
};

let inflight = null;
let timer = null;
let refreshCount = 0;
let lastRefreshMs = 0;

const SITE_HEADERS = Object.freeze({
  Referer: `${SITE}/`,
  Accept: 'text/html,application/xhtml+xml',
});

function dedupeChannels(channels, stats) {
  const seen = new Set();
  const unique = [];
  for (const channel of channels) {
    if (!channel || !Number.isInteger(channel.id) || !channel.name) {
      stats.channelInvalid++;
      continue;
    }
    if (seen.has(channel.id)) {
      stats.channelDuplicates++;
      continue;
    }
    seen.add(channel.id);
    unique.push(channel);
  }
  unique.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return unique;
}

function normaliseEvents(events) {
  const valid = events.filter(
    (event) =>
      event &&
      typeof event.title === 'string' &&
      event.title.length > 0 &&
      Number.isFinite(event.startMs) &&
      Number.isFinite(event.endMs) &&
      Array.isArray(event.channelIds),
  );
  valid.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
  return valid;
}

function recordError(scope, err) {
  return {
    scope,
    message: err && err.message ? err.message : String(err),
    status: err && typeof err.status === 'number' ? err.status : undefined,
    at: new Date().toISOString(),
  };
}

async function doRefresh() {
  const startedAt = Date.now();
  const results = await Promise.allSettled([
    fetchText(`${SITE}/24-7-channels.php`, { headers: SITE_HEADERS, retries: 1 }),
    fetchText(`${SITE}/`, { headers: SITE_HEADERS, retries: 1 }),
  ]);

  const errors = [];
  const stats = {
    channelCards: 0,
    channelDuplicates: 0,
    channelInvalid: 0,
    eventBlocks: 0,
    eventSkipped: 0,
    channelAdult: 0,
    eventAdult: 0,
  };

  const [channelsResult, eventsResult] = results;
  let channelsOk = false;
  let eventsOk = false;

  if (channelsResult.status === 'fulfilled') {
    try {
      const parsed = parseChannels(channelsResult.value);
      const scrapeStats = parsed.stats ?? {};
      stats.channelCards = scrapeStats.parsed ?? parsed.length;
      const unique = dedupeChannels(parsed, stats);
      const visible = config.excludeAdult
        ? unique.filter((channel) => {
            if (!isAdultText(channel.name)) return true;
            stats.channelAdult++;
            return false;
          })
        : unique;
      snapshot.channels = visible;
      channelsOk = true;
      log.info('catalogue: channels refreshed', {
        cards: stats.channelCards,
        unique: unique.length,
        duplicates: stats.channelDuplicates,
        adultFiltered: stats.channelAdult,
      });
    } catch (err) {
      errors.push(recordError('channels', err));
      log.error('catalogue: channel parse failed', err);
    }
  } else {
    errors.push(recordError('channels', channelsResult.reason));
    log.warn('catalogue: channel fetch failed, keeping previous snapshot', channelsResult.reason);
  }

  if (eventsResult.status === 'fulfilled') {
    try {
      const parsed = parseEvents(eventsResult.value);
      const scrapeStats = parsed.stats ?? {};
      stats.eventBlocks = scrapeStats.blocks ?? parsed.length;
      stats.eventSkipped = scrapeStats.skipped ?? 0;
      const events = normaliseEvents(parsed);
      const visibleEvents = config.excludeAdult
        ? events.filter((event) => {
            if (!isAdultText(event.title)) return true;
            stats.eventAdult++;
            return false;
          })
        : events;
      snapshot.events = visibleEvents;
      eventsOk = true;
      log.info('catalogue: events refreshed', {
        blocks: stats.eventBlocks,
        kept: visibleEvents.length,
        skipped: stats.eventSkipped,
        adultFiltered: stats.eventAdult,
      });
    } catch (err) {
      errors.push(recordError('events', err));
      log.error('catalogue: event parse failed', err);
    }
  } else {
    errors.push(recordError('events', eventsResult.reason));
    log.warn('catalogue: event fetch failed, keeping previous snapshot', eventsResult.reason);
  }

  const anySuccess = channelsOk || eventsOk;
  if (anySuccess) {
    snapshot.fetchedAt = Date.now();
    refreshCount++;
    lastRefreshMs = snapshot.fetchedAt - startedAt;
  }

  snapshot.errors = errors;
  snapshot.stats = stats;

  return getStats();
}

/**
 * Refresh the snapshot now. Single-flight: concurrent callers share the same
 * promise. Never rejects; failures are reflected in `getStats().errors`.
 */
export function refreshNow() {
  if (inflight) return inflight;
  inflight = doRefresh()
    .catch((err) => {
      // doRefresh is defensive, but never let a refresh take down a caller.
      snapshot.errors = [...snapshot.errors, recordError('refresh', err)];
      log.error('catalogue: refresh crashed', err);
      return getStats();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** @returns {Array<{id:number,name:string,group:string}>} */
export function getChannels() {
  return snapshot.channels;
}

/** @returns {Array<{id:number,title:string,category:string,startMs:number,endMs:number,channelIds:number[],channelNames:string[]}>} */
export function getEvents() {
  return snapshot.events;
}

export function getStats() {
  return {
    channels: snapshot.channels.length,
    events: snapshot.events.length,
    fetchedAt: snapshot.fetchedAt,
    ageMs: snapshot.fetchedAt ? Date.now() - snapshot.fetchedAt : null,
    stale: snapshot.fetchedAt > 0 && snapshot.errors.length > 0,
    errors: [...snapshot.errors],
    refreshes: refreshCount,
    lastRefreshMs,
    refreshing: inflight !== null,
    stats: { ...snapshot.stats },
  };
}

/**
 * Start the background refresh loop. Safe to call multiple times; returns the
 * shared promise for the initial refresh so startup can optionally await it.
 */
export function startCatalogRefresh() {
  if (!timer) {
    timer = setInterval(() => {
      refreshNow().catch(() => {});
    }, config.catalogRefreshMin * 60_000);
    if (typeof timer.unref === 'function') timer.unref();
    log.info('catalogue: refresh loop started', { everyMin: config.catalogRefreshMin });
  }
  return refreshNow();
}

export default {
  getChannels,
  getEvents,
  getStats,
  refreshNow,
  startCatalogRefresh,
};
