/**
 * Provider registry with a small TTL cache, per-id single-flight and a
 * negative cache with exponential backoff.
 *
 * Order: tossequip (primary) -> fallback (best effort). A resolve() call only
 * rejects with ResolveError after every provider has failed.
 *
 * Failures are remembered so a client that retries a dead channel (Jellyfin
 * does this aggressively) does not turn into a burst of upstream requests:
 *  - `provider-unsupported` (the id lives on a player we cannot script) is
 *    cached for an hour and never retried through the fallback,
 *  - everything else backs off 30s -> 10min.
 */

import { config, PROVIDER } from '../config.js';
import * as log from '../log.js';
import * as tossequip from './tossequip.js';
import * as fallback from './fallback.js';

export { ResolveError } from './tossequip.js';
import { ResolveError } from './tossequip.js';

/** @type {Map<string, {value: Object, expiresAt: number}>} */
const cache = new Map();
/** @type {Map<string, Promise<Object>>} */
const inflight = new Map();
/** @type {Map<string, {until:number, count:number, reason:string, message:string, host?:string, attempts?:string[]}>} */
const failures = new Map();

const FAILURE_BASE_MS = 30_000;
const FAILURE_MAX_MS = 10 * 60_000;
const UNSUPPORTED_MS = 60 * 60_000;

let unplayableRevision = 0;
let lastUnplayableKey = '';

const counters = {
  hits: 0,
  misses: 0,
  resolved: 0,
  failed: 0,
  throttled: 0,
  byProvider: Object.create(null),
};

function ttlMs() {
  return config.resolveTtlSec * 1000;
}

function noteProvider(provider) {
  counters.byProvider[provider] = (counters.byProvider[provider] ?? 0) + 1;
}

function backoffMs(err, count) {
  if (err && err.reason === 'provider-unsupported') return UNSUPPORTED_MS;
  return Math.min(FAILURE_BASE_MS * 2 ** Math.max(0, count - 1), FAILURE_MAX_MS);
}

function recordFailure(key, err) {
  const previous = failures.get(key);
  const count = (previous ? previous.count : 0) + 1;
  failures.set(key, {
    until: Date.now() + backoffMs(err, count),
    count,
    reason: (err && (err.reason || err.name)) || 'unknown',
    message: (err && err.message) || 'resolve failed',
    host: err && err.host,
    attempts: err && err.attempts,
  });
}

function cachedFailure(key) {
  const failure = failures.get(key);
  if (!failure) return null;
  if (failure.until > Date.now()) return failure;
  failures.delete(key);
  return null;
}

async function tryTossequip(id, attempts) {
  try {
    const result = await tossequip.resolve(id);
    if (result && typeof result.url === 'string') return { result, error: null };
    attempts.push(`${PROVIDER.TOSSEQUIP}:empty`);
  } catch (err) {
    const reason = err && err.reason ? err.reason : err && err.message ? err.message : 'unknown';
    attempts.push(`${PROVIDER.TOSSEQUIP}:${reason}`);
    log.debug('provider: tossequip failed', { id, reason });
    return { result: null, error: err };
  }
  return { result: null, error: null };
}

async function tryFallback(id, attempts) {
  try {
    const result = await fallback.resolve(id);
    if (result && typeof result.url === 'string') return result;
    attempts.push(`${PROVIDER.FALLBACK}:empty`);
  } catch (err) {
    // fallback.resolve is contractually null-only, but stay defensive: an
    // unknown provider failure must never escape as an untyped error.
    const reason = err && err.reason ? err.reason : err && err.message ? err.message : 'unknown';
    attempts.push(`${PROVIDER.FALLBACK}:${reason}`);
    log.debug('provider: fallback failed', { id, reason });
  }
  return null;
}

async function doResolve(id) {
  const attempts = [];

  const primary = await tryTossequip(id, attempts);
  if (primary.result) return primary.result;

  // The page named a player we cannot script (vertex.st, embedindia.st, …).
  // The fallback only knows /player/ wideiptv ids, so trying it wastes 8s.
  if (primary.error && primary.error.reason === 'provider-unsupported') {
    throw new ResolveError('provider-unsupported', primary.error.message, {
      attempts,
      host: primary.error.host,
    });
  }

  const secondary = await tryFallback(id, attempts);
  if (secondary) return secondary;

  throw new ResolveError('all-failed', `no provider could resolve id ${id}`, { attempts });
}

/**
 * Resolve a channel/event id to a playable HLS URL.
 *
 * @param {number|string} id
 * @returns {Promise<{url:string,headers:Record<string,string>,ttlMs:number,provider:string}>}
 */
export async function resolve(id) {
  const key = String(id).trim();
  const numericId = Number(key);
  if (!/^\d+$/.test(key) || !Number.isInteger(numericId) || numericId < 0) {
    throw new ResolveError('invalid-id', `invalid channel id ${JSON.stringify(id)}`);
  }

  const now = Date.now();
  const cached = cache.get(key);
  if (cached) {
    if (cached.expiresAt > now) {
      counters.hits++;
      return cached.value;
    }
    cache.delete(key);
  }

  const failure = cachedFailure(key);
  if (failure) {
    counters.throttled++;
    throw new ResolveError(failure.reason, failure.message, {
      attempts: failure.attempts,
      host: failure.host,
      cachedFailure: true,
      retryAfterMs: failure.until - now,
    });
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  counters.misses++;
  const promise = doResolve(numericId)
    .then((result) => {
      cache.set(key, { value: result, expiresAt: Date.now() + ttlMs() });
      failures.delete(key);
      counters.resolved++;
      noteProvider(result.provider);
      return result;
    })
    .catch((err) => {
      counters.failed++;
      recordFailure(key, err);
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/** Drop one cached resolution (used after an upstream 403/404). */
export function invalidate(id) {
  const key = String(id).trim();
  failures.delete(key);
  return cache.delete(key);
}

/**
 * Ids that are definitively served by an unscriptable player, so the playlist
 * can stop advertising them until the backoff window expires.
 *
 * @returns {string[]} sorted ids
 */
export function unplayableIds() {
  const now = Date.now();
  const ids = [];
  for (const [key, failure] of failures) {
    if (failure.reason === 'provider-unsupported' && failure.until > now) ids.push(key);
  }
  ids.sort((a, b) => Number(a) - Number(b));
  return ids;
}

/**
 * Stable digest of the unplayable set; changes only when the set changes so
 * playlist ETags stay valid across requests.
 */
export function unplayableKey() {
  const key = unplayableIds().join(',');
  if (key !== lastUnplayableKey) {
    lastUnplayableKey = key;
    unplayableRevision++;
  }
  return key;
}

export function stats() {
  return {
    cached: cache.size,
    inflight: inflight.size,
    failures: failures.size,
    hits: counters.hits,
    misses: counters.misses,
    throttled: counters.throttled,
    resolved: counters.resolved,
    failed: counters.failed,
    ttlSec: config.resolveTtlSec,
    byProvider: { ...counters.byProvider },
    unplayable: unplayableIds().length,
    unplayableRevision,
  };
}

export default { resolve, invalidate, stats, unplayableIds, unplayableKey, ResolveError };
