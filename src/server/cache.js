/**
 * Tiny TTL cache with per-key single-flight.
 *
 * Used for generated playlist/XMLTV bodies and for the stream resolutions
 * served by the proxy. Expired entries are dropped lazily. Concurrent callers
 * asking for the same missing key share one in-flight promise.
 */

/** @type {Map<string, {value: unknown, expiresAt: number}>} */
const entries = new Map();
/** @type {Map<string, Promise<unknown>>} */
const pending = new Map();

function normaliseTtl(ttlMs) {
  const ttl = Number(ttlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

/**
 * Read a cached value, or compute and cache it.
 *
 * @template T
 * @param {string} key
 * @param {number} ttlMs non-positive means "do not store"
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function get(key, ttlMs, fn) {
  if (typeof fn !== 'function') throw new TypeError('cache.get requires a function');
  const cacheKey = String(key);
  const now = Date.now();

  const hit = entries.get(cacheKey);
  if (hit !== undefined) {
    if (hit.expiresAt > now) return hit.value;
    entries.delete(cacheKey);
  }

  const inflight = pending.get(cacheKey);
  if (inflight) return inflight;

  const ttl = normaliseTtl(ttlMs);
  const promise = Promise.resolve()
    .then(fn)
    .then((value) => {
      if (ttl > 0) entries.set(cacheKey, { value, expiresAt: Date.now() + ttl });
      return value;
    })
    .finally(() => {
      pending.delete(cacheKey);
    });

  pending.set(cacheKey, promise);
  return promise;
}

/**
 * Drop every cached entry whose key starts with `prefix`.
 *
 * In-flight computations are intentionally left alone: they cannot be
 * cancelled, and their results are still valid for callers already waiting.
 *
 * @param {string} prefix
 * @returns {number} number of entries removed
 */
export function invalidate(prefix) {
  const needle = String(prefix);
  let removed = 0;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(needle)) {
      entries.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Number of live cached entries (expired entries are counted until read). */
export function size() {
  return entries.size;
}

/** Drop everything. Handy for tests. */
export function clear() {
  entries.clear();
}

export default { get, invalidate, size, clear };
