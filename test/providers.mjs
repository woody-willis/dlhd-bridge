/**
 * Live provider tests (set OFFLINE=1 to skip).
 *
 * Observed working ids (2026-11-10, TZ=UTC): 61 (used by the test), plus 405,
 * 667 and 316 — all resolved via tossequip to playable media playlists.
 * id 61 playlist head (sequence/target duration advance with the live edge):
 *   https://8z09jo.7odxv0l067ka.net:8443/hls/k5atkajfhkgk1.m3u8?s=…&e=…
 *   #EXTM3U
 *   #EXT-X-VERSION:3
 *   #EXT-X-MEDIA-SEQUENCE:17386
 *   #EXT-X-TARGETDURATION:7
 *   #EXTINF:5.000,
 *   k5atkajfhkgk1-<n>.ts
 *
 * The playlist host requires a Chrome user-agent plus Referer:
 * https://tossequip.net/ (fetchText supplies the configured UA).
 *
 *   node --test test/providers.mjs
 *   OFFLINE=1 node --test test/providers.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolve, stats } from '../src/providers/index.js';
import { fetchText } from '../src/http.js';

const OFFLINE = process.env.OFFLINE === '1';

// A handful of ids that have rotated through the /cast/ player. Stop at the
// first success to keep the upstream request count small.
const CANDIDATES = [61, 405, 667, 316];

test('providers: at least one candidate resolves to a playable HLS playlist', { skip: OFFLINE ? 'OFFLINE=1' : false, timeout: 180_000 }, async (t) => {
  const failures = [];
  let working = null;

  for (const id of CANDIDATES) {
    try {
      const result = await resolve(id);
      working = { id, result };
      break;
    } catch (err) {
      failures.push(`${id}: ${err.name}${err.reason ? `/${err.reason}` : ''} ${err.message}`);
    }
  }

  assert.ok(
    working,
    `no candidate resolved; attempts:\n${failures.join('\n')}`,
  );

  const { id, result } = working;
  assert.match(result.url, /^https:\/\//, 'resolution must be an https URL');
  assert.equal(result.provider, 'tossequip');
  assert.ok(result.ttlMs > 0);
  assert.equal(result.headers.Referer, 'https://tossequip.net/');

  t.diagnostic(`resolved id ${id} via ${result.provider}: ${result.url.split('?')[0]}`);

  const playlist = await fetchText(result.url, { headers: result.headers });
  assert.match(playlist, /^\s*#EXTM3U/, 'playlist must start with #EXTM3U');
  assert.match(
    playlist,
    /#EXTINF|#EXT-X-STREAM-INF/,
    'playlist must contain at least one segment or variant',
  );

  // The second call must be served from the TTL cache (no upstream request).
  const cached = await resolve(id);
  assert.equal(cached.url, result.url);
  assert.ok(stats().hits >= 1, 'cache hit should be recorded');

  const head = playlist.split('\n').slice(0, 5);
  t.diagnostic(`playlist head: ${head.join(' | ')}`);
});

test('providers: repeated failures are throttled instead of retried upstream', { skip: OFFLINE ? 'OFFLINE=1' : false, timeout: 180_000 }, async (t) => {
  // 999999999 does not exist, so the site serves no playable player for it.
  // The first attempt is allowed to touch the network; every retry inside the
  // backoff window must be answered from the negative cache.
  const before = stats();
  let first;
  try {
    await resolve(999999999);
    t.skip('upstream unexpectedly resolved a nonexistent id');
    return;
  } catch (err) {
    first = err;
  }
  assert.ok(first && first.reason, 'failure must carry a reason');
  assert.match(String(first.reason), /^(provider-unsupported|iframe-missing|http|all-failed)$/);

  const afterFirst = stats();
  assert.equal(afterFirst.misses, before.misses + 1, 'exactly one upstream attempt');

  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => resolve(999999999), (err) => {
      assert.equal(err.cachedFailure, true, 'retry must come from the negative cache');
      return true;
    });
  }

  const after = stats();
  assert.equal(after.misses, afterFirst.misses, 'no further upstream attempts');
  assert.ok(after.throttled >= afterFirst.throttled + 4, 'throttled counter advances');
  t.diagnostic(`reason=${first.reason} throttled=${after.throttled - afterFirst.throttled}`);
});
