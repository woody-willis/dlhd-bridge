/**
 * Server layer tests.
 *
 * Pure generator/rewrite tests always run. The HTTP server tests need an
 * ephemeral listener and one live upstream resolution (id 61); set OFFLINE=1
 * to skip the whole server block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildPlaylist, resolveBaseUrl, sanitizeHost } from '../src/server/playlist.js';
import { buildXmltv, formatXmltvTime, escapeXml } from '../src/server/xmltv.js';
import {
  rewritePlaylistBody,
  encodeSegmentToken,
  decodeSegmentToken,
  isAllowedHost,
} from '../src/server/hls.js';
import * as cache from '../src/server/cache.js';
import { createServer } from '../src/server/index.js';

const OFFLINE = process.env.OFFLINE === '1';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/catalogue.json', import.meta.url), 'utf8'),
);
const { channels, events, nowMs } = fixture;
const BASE = 'http://example.test:8080';

test('playlist: modes, ordering, ids and counts', () => {
  const all = buildPlaylist({
    channels,
    events,
    mode: 'all',
    windowMin: 120,
    baseUrl: BASE,
    nowMs,
  });
  assert.equal(all.count, 5);
  assert.equal((all.body.match(/^#EXTINF/gm) || []).length, 5);
  assert.ok(all.body.startsWith(`#EXTM3U x-tvg-url="${BASE}/xmltv.xml"`));

  assert.ok(all.body.includes('tvg-id="dlhd-61"'));
  assert.ok(all.body.includes('group-title="24/7 | B",beIN Sports MENA English 1'));
  assert.ok(all.body.includes(`${BASE}/stream/61.m3u8`));

  assert.ok(all.body.includes('tvg-id="dlhd-ev-337"'));
  assert.ok(
    all.body.includes(
      'group-title="Live | All Soccer ⚽",Team A & Team <B> [tennis stream, extra stream]',
    ),
  );
  assert.ok(all.body.includes(`${BASE}/stream/32.m3u8`));
  assert.ok(all.body.includes('tvg-id="dlhd-ev-338"'));
  assert.ok(all.body.includes(`${BASE}/stream/61.m3u8`));

  // Channels are ordered by group then name: A, B, S.
  const order = ['ABC USA', 'beIN Sports MENA English 1', 'SEE Denmark'].map((name) =>
    all.body.indexOf(`,${name}`),
  );
  assert.ok(order[0] < order[1] && order[1] < order[2], 'channels should be group/name sorted');

  const channelsOnly = buildPlaylist({ channels, events, mode: 'channels', baseUrl: BASE, nowMs });
  assert.equal(channelsOnly.count, 3);
  assert.ok(!channelsOnly.body.includes('dlhd-ev-'));

  const eventsOnly = buildPlaylist({ channels, events, mode: 'events', baseUrl: BASE, nowMs });
  assert.equal(eventsOnly.count, 2);

  const live = buildPlaylist({ channels, events, mode: 'live', windowMin: 120, baseUrl: BASE, nowMs });
  assert.equal(live.count, 1);
  assert.ok(live.body.includes('tvg-id="dlhd-ev-337"'));
  assert.ok(!live.body.includes('tvg-id="dlhd-ev-338"'));
  assert.ok(!live.body.includes('tvg-id="dlhd-61"'));

  const liveFuture = buildPlaylist({
    channels,
    events,
    mode: 'live',
    windowMin: 120,
    includeFuture: true,
    baseUrl: BASE,
    nowMs,
  });
  assert.equal(liveFuture.count, 2);

  const limited = buildPlaylist({ channels, events, mode: 'all', limit: 2, baseUrl: BASE, nowMs });
  assert.equal(limited.count, 2);
  assert.equal((limited.body.match(/^#EXTINF/gm) || []).length, 2);

  const relative = buildPlaylist({ channels, events, mode: 'all', nowMs });
  assert.ok(relative.body.startsWith('#EXTM3U\n'));
  assert.ok(relative.body.includes('/stream/61.m3u8'));

  const deduped = buildPlaylist({
    channels: [...channels, channels[0]],
    events: [...events, events[0]],
    mode: 'all',
    baseUrl: BASE,
    nowMs,
  });
  assert.equal(deduped.count, 5);

  assert.throws(
    () => buildPlaylist({ channels, events, mode: 'bogus', nowMs }),
    /unknown playlist mode/,
  );
});

test('playlist: events with only the id-0 placeholder channel are dropped', () => {
  const base = {
    title: 'Placeholder Event',
    category: 'All Soccer ⚽',
    startMs: 1799998200000,
    endMs: 1800009000000,
    channelNames: ['player 2'],
  };
  const placeholder = { ...base, id: 401, channelIds: [0] };
  const mixed = { ...base, id: 402, channelIds: [0, 61], channelNames: ['placeholder', 'beIN'] };

  const all = buildPlaylist({ channels, events: [placeholder, mixed], mode: 'all', baseUrl: BASE, nowMs });
  assert.equal(all.count, 4); // 3 channels + 1 playable event
  assert.ok(!all.body.includes('/stream/0.m3u8'));
  assert.ok(all.body.includes('tvg-id="dlhd-ev-402"'));
  assert.ok(all.body.includes(`${BASE}/stream/61.m3u8`));
  // Only one playable channel remains, so no name suffix is added.
  assert.ok(!all.body.includes('placeholder'));
  assert.ok(all.body.includes(`tvg-name="Placeholder Event"`));

  const xml = buildXmltv({ channels, events: [placeholder, mixed], nowMs });
  assert.ok(!xml.body.includes('dlhd-ev-401'));
  assert.ok(xml.body.includes('dlhd-ev-402'));
  assert.equal(xml.channels, 4); // 3 channels + 1 event
  assert.equal(xml.programmes, 13); // 12 blocks + 1 event

  // Events that finished long ago are dead streams and are skipped; anything
  // within the 6h grace window is still listed.
  const endedLongAgo = { ...base, id: 403, channelIds: [61], channelNames: ['beIN'], startMs: nowMs - 12 * 3600e3, endMs: nowMs - 9 * 3600e3 };
  const justEnded = { ...base, id: 404, channelIds: [61], channelNames: ['beIN'], startMs: nowMs - 4 * 3600e3, endMs: nowMs - 3600e3 };
  const timed = buildPlaylist({ channels, events: [endedLongAgo, justEnded], mode: 'all', baseUrl: BASE, nowMs });
  assert.equal(timed.count, 4); // 3 channels + 1 recent event
  assert.ok(!timed.body.includes('dlhd-ev-403'));
  assert.ok(timed.body.includes('dlhd-ev-404'));
});

test('playlist: unplayable ids can be excluded without breaking the rest', () => {
  const all = buildPlaylist({
    channels,
    events,
    mode: 'all',
    baseUrl: BASE,
    nowMs,
    excludeChannelIds: [61],
  });
  // Channel 61 is gone, event 338 pointed only at 61 so it is gone too.
  assert.equal(all.count, 3);
  assert.ok(!all.body.includes('tvg-id="dlhd-61"'));
  assert.ok(!all.body.includes('tvg-id="dlhd-ev-338"'));
  assert.ok(all.body.includes('tvg-id="dlhd-ev-337"'));
  assert.ok(all.body.includes(`${BASE}/stream/32.m3u8`));
});

test('playlist: base URL derivation rejects header injection', () => {
  assert.equal(sanitizeHost('example.com:8080'), 'example.com:8080');
  assert.equal(sanitizeHost('[::1]:8080'), '[::1]:8080');
  assert.equal(sanitizeHost('evil.com"\r\nX-Injected: yes'), null);
  assert.equal(sanitizeHost('exa mple.com'), null);
  assert.equal(sanitizeHost('example.com:99999'), null);

  assert.equal(
    resolveBaseUrl({ headers: { host: 'evil.com"\nX: y' }, socket: { localPort: 8080 } }),
    'http://localhost:8080',
  );
  assert.equal(
    resolveBaseUrl({
      headers: { host: 'media.example:8080', 'x-forwarded-proto': 'https, http' },
      socket: {},
    }),
    'https://media.example:8080',
  );
});

test('xmltv: structure, escaping, counts and time format', () => {
  const out = buildXmltv({ channels, events, nowMs });

  assert.match(out.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(out.body.includes('<!DOCTYPE tv SYSTEM "xmltv.dtd">'));
  assert.ok(out.body.includes('<tv generator-info-name="dlhd-bridge">'));
  assert.ok(out.body.includes('id="dlhd-61"'));
  assert.ok(out.body.includes('id="dlhd-ev-337"'));
  assert.ok(out.body.includes('<icon src=""/>'));

  assert.ok(out.body.includes('Team A &amp; Team &lt;B&gt;'));
  assert.ok(out.body.includes('O&apos;Reilly'));
  assert.ok(out.body.includes('Tennis &amp; Racket'));

  // 3 channels x 4 blocks + 2 events.
  assert.equal(out.channels, 5);
  assert.equal(out.programmes, 14);
  assert.equal(out.truncated, false);

  const programmes = [...out.body.matchAll(/<programme start="(\d{14}) \+0000" stop="(\d{14}) \+0000"/g)];
  assert.equal(programmes.length, 14);
  for (let i = 0; i < 12; i++) {
    const hour = Number(programmes[i][1].slice(8, 10));
    assert.equal(hour % 6, 0, `24/7 block ${i} should start on a 6h boundary`);
  }

  assert.equal(formatXmltvTime(1799998200000), '20270115073000 +0000');
  assert.equal(escapeXml(`a&b<c>"d"'e`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e');

  const capped = buildXmltv({ channels, events, nowMs, maxProgrammes: 5 });
  assert.equal(capped.programmes, 5);
  assert.equal(capped.truncated, true);
});

test('hls: playlist rewrite preserves structure and hides upstream URLs', () => {
  const source =
    '#EXTM3U\r\n' +
    '#EXT-X-VERSION:3\r\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\r\n' +
    '#EXT-X-MAP:URI="https://tossequip.net/init.mp4"\r\n' +
    '#EXTINF:5.000,\r\n' +
    'seg-1.ts\r\n' +
    '#EXT-X-ENDLIST\r\n';
  const out = rewritePlaylistBody(source, 'https://tossequip.net/live/index.m3u8', '61');

  assert.ok(out.includes('\r\n'), 'CRLF line endings must be preserved');
  assert.ok(out.includes('#EXT-X-VERSION:3\r\n'));
  assert.ok(out.includes('#EXT-X-ENDLIST\r\n'));
  // ffmpeg refuses HLS segment URLs without a media extension, so every proxy
  // path must carry one derived from the original URI.
  assert.match(out, /#EXT-X-KEY:METHOD=AES-128,URI="\/seg\/61\/[A-Za-z0-9_-]+\.bin"/);
  assert.match(out, /#EXT-X-MAP:URI="\/seg\/61\/[A-Za-z0-9_-]+\.mp4"/);
  assert.match(out, /^\/seg\/61\/[A-Za-z0-9_-]+\.ts$/m);
  assert.ok(!out.includes('key.bin"'));
  assert.ok(!out.includes('seg-1.ts'));
  assert.ok(!out.includes('https://tossequip.net'));

  const token = encodeSegmentToken('https://tossequip.net/a/seg.ts?sig=1');
  assert.equal(decodeSegmentToken(token)?.toString(), 'https://tossequip.net/a/seg.ts?sig=1');
  assert.equal(
    decodeSegmentToken(`${token}.ts`)?.toString(),
    'https://tossequip.net/a/seg.ts?sig=1',
    'a trailing media extension must be ignored',
  );
  assert.equal(decodeSegmentToken(encodeSegmentToken('http://tossequip.net/x.ts')), null);
  assert.equal(decodeSegmentToken(encodeSegmentToken('https://evil.example/x.ts')), null);
  assert.equal(decodeSegmentToken('not base64!'), null);
  assert.equal(isAllowedHost('sub.tossequip.net'), true);
  assert.equal(isAllowedHost('tossequip.net.evil.com'), false);
});

test('cache: single-flight, TTL and prefix invalidation', async () => {
  cache.clear();
  let calls = 0;
  const compute = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { n: calls };
  };

  const [a, b] = await Promise.all([
    cache.get('test:a', 1000, compute),
    cache.get('test:a', 1000, compute),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(cache.size(), 1);

  await cache.get('test:b', 0, async () => 1);
  assert.equal(cache.size(), 1, 'ttl 0 must not store');

  await new Promise((resolve) => setTimeout(resolve, 30));
  await cache.get('test:expired', 20, compute);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await cache.get('test:expired', 1000, compute)).n, 3);
  assert.equal(cache.invalidate('test:'), 2);
  assert.equal(cache.size(), 0);
});

test('http server: routes, ETags and live HLS proxy', { skip: OFFLINE ? 'OFFLINE=1' : false, timeout: 180_000 }, async (t) => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) =>
    fetch(origin + path, { signal: AbortSignal.timeout(120_000), ...init });

  await t.test('healthz and HEAD', async () => {
    const res = await request('/healthz');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const json = await res.json();
    assert.equal(typeof json.ok, 'boolean');
    for (const key of ['channels', 'events', 'resolved', 'uptime']) {
      assert.equal(typeof json[key], 'number', `${key} should be a number`);
    }

    const head = await request('/healthz', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });

  await t.test('playlist, alias and 304', async () => {
    const res = await request('/playlist.m3u');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /^#EXTM3U/);
    assert.match(res.headers.get('cache-control'), /max-age=30/);

    const etag = res.headers.get('etag');
    assert.ok(etag, 'playlist must carry an ETag');
    assert.match(etag, /^W\/"/);

    const cached = await request('/playlist.m3u', { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');

    const alias = await request('/playlist.m3u8');
    assert.equal(alias.status, 200);
    assert.match(await alias.text(), /^#EXTM3U/);
  });

  await t.test('xmltv and alias', async () => {
    const res = await request('/xmltv.xml');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('<tv'));
    assert.ok(body.includes('generator-info-name="dlhd-bridge"'));
    assert.match(res.headers.get('cache-control'), /max-age=300/);

    const alias = await request('/epg.xml');
    assert.equal(alias.status, 200);
    assert.ok((await alias.text()).includes('<tv'));
  });

  await t.test('status page, 404 and 405', async () => {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /dlhd-bridge/);

    const missing = await request('/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not_found');

    const wrong = await request('/healthz', { method: 'POST' });
    assert.equal(wrong.status, 405);
    assert.match(wrong.headers.get('allow'), /GET/);
    await wrong.text();
  });

  await t.test('live /stream/61.m3u8 and segment proxy', async (tt) => {
    const res = await request('/stream/61.m3u8');
    if (res.status === 502) {
      const detail = (await res.text()).trim();
      tt.diagnostic(`upstream resolve failed for id 61: ${detail}`);
      return tt.skip('id 61 could not be resolved upstream (skipping live proxy test)');
    }
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /^#EXTM3U/);
    assert.match(body, /\/seg\//, 'rewritten playlist should reference /seg/ paths');
    assert.ok(!body.includes('tossequip.net'), 'upstream host must not leak');

    const segLine = body.split(/\r?\n/).find((line) => line.trim().startsWith('/seg/'));
    assert.ok(segLine, 'playlist should contain a segment path');
    const segUrl = new URL(segLine.trim(), origin).toString();

    const seg = await fetch(segUrl, {
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok([200, 206].includes(seg.status), `segment responded ${seg.status}`);
    const bytes = new Uint8Array(await seg.arrayBuffer());
    assert.ok(bytes.length > 0, 'segment body must not be empty');
    assert.match(seg.headers.get('cache-control'), /max-age=60/);

    tt.diagnostic(
      `stream/61: ${body.length} B playlist; segment ${seg.status}, ${bytes.length} B`,
    );
  });
});
