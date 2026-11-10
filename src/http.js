/**
 * HTTP helpers around the global fetch (Node 22 / undici).
 *
 * - applies the configured User-Agent,
 * - follows redirects,
 * - enforces a timeout,
 * - retries idempotent GETs (network errors and 5xx) up to 2 times with
 *   jittered exponential-ish backoff,
 * - throws typed UpstreamError values,
 * - never logs a URL query string.
 */

import { config } from './config.js';
import { debug, warn } from './log.js';

/** Maximum number of retries allowed, regardless of the caller's request. */
export const MAX_RETRIES = 2;

/** Strip the query string from a URL for safe logging / error reporting. */
export function stripQuery(url) {
  try {
    const parsed = new URL(String(url));
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(url).split('?')[0].split('#')[0];
  }
}

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, url?: string, code?: string, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'UpstreamError';
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.url !== undefined) {
      this.url = opts.url;
      this.safeUrl = stripQuery(opts.url);
    }
    if (opts.code !== undefined) this.code = opts.code;
  }
}

function backoffDelay(attempt) {
  // attempt 0 -> ~150-450ms, attempt 1 -> ~300-900ms
  const base = 150 * 2 ** attempt;
  return base + Math.floor(Math.random() * base * 2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(timeoutMs, external) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.upstreamTimeoutMs;
  if (external) {
    // Combine an optional caller signal with our own timeout.
    const timeout = AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeout]);
    return timeout;
  }
  return AbortSignal.timeout(ms);
}

async function fetchOnce(url, { headers, timeoutMs, signal } = {}) {
  const merged = {
    'user-agent': config.userAgent,
    accept: '*/*',
    ...headers,
  };
  return fetch(url, {
    method: 'GET',
    headers: merged,
    redirect: 'follow',
    signal: timeoutSignal(timeoutMs, signal),
  });
}

function networkError(err, url) {
  const code =
    err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? 'timeout'
      : (err && err.code) || 'network';
  const message =
    code === 'timeout'
      ? `upstream timeout for ${stripQuery(url)}`
      : `upstream request failed for ${stripQuery(url)}`;
  return new UpstreamError(message, { url, code, cause: err });
}

function retryableStatus(status) {
  return status >= 500 && status <= 599;
}

/**
 * Fetch a URL and return its body as text.
 *
 * Retries network errors and 5xx responses. 4xx responses are returned as an
 * UpstreamError immediately (they are not idempotent failures we can back out
 * of). The optional `retries` value is clamped to MAX_RETRIES.
 *
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, retries?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<string>}
 */
export async function fetchText(url, opts = {}) {
  const { headers = {}, timeoutMs = config.upstreamTimeoutMs } = opts;
  const retries = Math.max(0, Math.min(MAX_RETRIES, Number(opts.retries ?? MAX_RETRIES) | 0));

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchOnce(url, { headers, timeoutMs, signal: opts.signal });
      if (res.ok) {
        const text = await res.text();
        debug('http ok', { status: res.status, url: stripQuery(url), bytes: text.length });
        return text;
      }

      // Release the socket without buffering an error body we do not need.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }

      const err = new UpstreamError(`upstream responded ${res.status} for ${stripQuery(url)}`, {
        status: res.status,
        url,
        code: 'http',
      });

      if (retryableStatus(res.status) && attempt < retries) {
        lastError = err;
        const delay = backoffDelay(attempt);
        warn('http retry', {
          status: res.status,
          url: stripQuery(url),
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      throw err;
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (retryableStatus(err.status) && attempt < retries) {
          lastError = err;
          const delay = backoffDelay(attempt);
          warn('http retry', {
            status: err.status,
            url: stripQuery(url),
            attempt: attempt + 1,
            delayMs: delay,
          });
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const wrapped = networkError(err, url);
      if (attempt < retries) {
        lastError = wrapped;
        const delay = backoffDelay(attempt);
        warn('http retry', {
          code: wrapped.code,
          url: stripQuery(url),
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      throw wrapped;
    }
  }
  throw lastError ?? new UpstreamError(`request failed for ${stripQuery(url)}`, { url, code: 'unknown' });
}

/**
 * Fetch a URL and return the live Response so a caller can stream the body
 * through without buffering. Non-2xx responses throw UpstreamError.
 *
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, retries?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchStream(url, opts = {}) {
  const { headers = {}, timeoutMs = config.upstreamTimeoutMs } = opts;
  const retries = Math.max(0, Math.min(MAX_RETRIES, Number(opts.retries ?? MAX_RETRIES) | 0));

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchOnce(url, { headers, timeoutMs, signal: opts.signal });
      if (res.ok) {
        debug('http stream ok', { status: res.status, url: stripQuery(url) });
        return res;
      }
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      const err = new UpstreamError(`upstream responded ${res.status} for ${stripQuery(url)}`, {
        status: res.status,
        url,
        code: 'http',
      });
      if (retryableStatus(res.status) && attempt < retries) {
        lastError = err;
        const delay = backoffDelay(attempt);
        warn('http stream retry', {
          status: res.status,
          url: stripQuery(url),
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      throw err;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      const wrapped = networkError(err, url);
      if (attempt < retries) {
        lastError = wrapped;
        const delay = backoffDelay(attempt);
        warn('http stream retry', {
          code: wrapped.code,
          url: stripQuery(url),
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      throw wrapped;
    }
  }
  throw lastError ?? new UpstreamError(`request failed for ${stripQuery(url)}`, { url, code: 'unknown' });
}

export default { fetchText, fetchStream, UpstreamError, stripQuery, MAX_RETRIES };
