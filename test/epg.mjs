/**
 * External EPG tests.
 *
 * Parsing, matching and the XMLTV merge always run (no network). The live test
 * loads the default epgshare01 source and is skipped with OFFLINE=1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseXmltv,
  parseXmltvChannels,
  parseProgrammes,
  parseXmltvTime,
  MAX_DESC_CHARS,
} from '../src/epg/parse.js';
import { normaliseName, channelCountry, matchChannels } from '../src/epg/match.js';
import { getGuide, getStats, epgRevision, refreshNow } from '../src/epg/index.js';
import { buildXmltv } from '../src/server/xmltv.js';

const OFFLINE = process.env.OFFLINE === '1';
const FIXTURE = readFileSync(new URL('./fixtures/epg.xml', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 13, 19, 0, 0);

const OUR_CHANNELS = [
  { id: 1, name: 'Sky Sports Football UK', group: 'S' },
  { id: 2, name: 'Sky Sports Main Event DE', group: 'S' },
  { id: 3, name: 'Arena Sport 1 Serbia', group: 'A' },
  { id: 4, name: 'Totally Unmatched Channel', group: 'T' },
];

const parsedFixture = () => parseXmltv(FIXTURE);

test('epg parse: channels, programmes, times and skipped entries', () => {
  const parsed = parsedFixture();

  assert.equal(parsed.channels.length, 4);
  assert.equal(parsed.stats.channels, 4);
  assert.equal(parsed.programmes.length, 5);
  assert.equal(parsed.stats.skippedProgrammes, 1, 'the bad start timestamp is skipped');

  const football = parsed.channels.find((channel) => channel.id === 'SkySp.Fball.uk');
  assert.deepEqual(football.names, ['SkySp Fball']);
  assert.equal(football.icon, 'https://example.test/logos/skysportsfootball.png');

  // +0000 and +0100 are both normalised to UTC milliseconds.
  assert.equal(parseXmltvTime('20261113190000 +0000'), NOW);
  assert.equal(parseXmltvTime('20261113210000 +0100'), Date.UTC(2026, 10, 13, 20, 0, 0));
  assert.ok(Number.isNaN(parseXmltvTime('not-a-date')));

  const title = parsed.programmes.find(
    (programme) => programme.channel === 'SkySp.Fball.uk' && programme.startMs === NOW,
  );
  assert.equal(title.title, 'Football & More <Live>', 'entities are decoded once');
  assert.equal(title.desc, "O'Reilly & co present the big match.");
  assert.equal(title.category, 'Football');
  assert.deepEqual(title.episode, { system: 'xmltv_ns', value: '0.1/2' });
  assert.equal(title.icon, 'https://example.test/logos/football-live.png');
  assert.equal(title.startMs, NOW);
  assert.equal(title.stopMs, NOW + 60 * 60 * 1000);
});

test('epg parse: programme pass only allocates for wanted channel ids', () => {
  const channelPass = parseXmltvChannels(FIXTURE);
  assert.equal(channelPass.channels.length, 4);
  assert.equal(channelPass.stats.channels, 4);
  assert.equal(channelPass.stats.skippedChannels, 0);

  // 6 <programme> elements: 4 on SkySp.Fball.uk (one broken), 1 DE, 1 HR.
  const only = parseProgrammes(FIXTURE, new Set(['SkySpMainEv.de']));
  assert.deepEqual(
    only.programmes.map((programme) => programme.channel),
    ['SkySpMainEv.de'],
  );
  assert.equal(only.stats.programmes, 1);
  assert.equal(only.stats.ignoredProgrammes, 5, 'other channels are skipped, not parsed');
  assert.equal(only.stats.skippedProgrammes, 0, 'an unwanted broken entry is never examined');

  const none = parseProgrammes(FIXTURE, new Set(['No.Such.Channel']));
  assert.equal(none.programmes.length, 0);
  assert.equal(none.stats.ignoredProgrammes, 6);

  // The wrapper keeps every programme (legacy behaviour) and still counts
  // the malformed entry as skipped.
  const all = parseProgrammes(FIXTURE);
  assert.equal(all.programmes.length, 5);
  assert.equal(all.stats.skippedProgrammes, 1);

  const longDesc = 'x'.repeat(MAX_DESC_CHARS + 50);
  const long = parseProgrammes(
    `<tv><programme start="20261113190000 +0000" stop="20261113200000 +0000" channel="A.b">` +
      `<title>A</title><desc>${longDesc}</desc></programme></tv>`,
    new Set(['A.b']),
  );
  assert.equal(long.programmes[0].desc.length, MAX_DESC_CHARS);

  // A programme with no channel attribute (or an empty one) is skipped, not
  // accidentally kept as a wanted entry.
  const noChannel = parseProgrammes(
    '<tv><programme start="20261113190000 +0000" stop="20261113200000 +0000">' +
      '<title>No channel</title></programme></tv>',
    new Set(['A.b']),
  );
  assert.equal(noChannel.programmes.length, 0);
  assert.equal(noChannel.stats.skippedProgrammes, 1);
});

test('epg match: normalisation, countries and exact keys only', () => {
  assert.deepEqual(normaliseName('SkySpMainEvHD'), ['sky', 'sp', 'main', 'ev']);
  assert.deepEqual(normaliseName('TNT Sport HD'), ['tnt', 'sport']);
  assert.deepEqual(normaliseName('Sky Sports+ Plus'), ['sky', 'sports', 'plus']);

  assert.equal(channelCountry('Sky Sports Football UK'), 'uk');
  assert.equal(channelCountry('Sky Sports 1 DE'), 'de');
  assert.equal(channelCountry('Eurosport 2 SW'), 'se');
  // Not in the accepted country list, so it stays part of the key and cannot
  // collide with a different-country "Arena Sport 1".
  assert.equal(channelCountry('Arena Sport 1 Serbia'), '');

  const { mapping, stats } = matchChannels(OUR_CHANNELS, parsedFixture().channels);
  assert.equal(mapping.get(1), 'SkySp.Fball.uk');
  assert.equal(mapping.get(2), 'SkySpMainEv.de');
  assert.equal(mapping.has(3), false, 'Serbia must not map to the Croatian channel');
  assert.equal(mapping.has(4), false);
  assert.ok([...mapping.values()].every((id) => !id.startsWith('Arena.Sport.1.hr')));
  assert.equal(stats.matched, 2);
  assert.equal(stats.ambiguous, 1, 'two same-country SkySp Fball ids are one feed');

  // The HD variant of the same feed must match the same channel on its own.
  const hdOnly = matchChannels(
    OUR_CHANNELS,
    parsedFixture().channels.filter((channel) => channel.id === 'SkySp.Fball.HD.uk'),
  );
  assert.equal(hdOnly.mapping.get(1), 'SkySp.Fball.HD.uk');
});

test('epg guide: merge into XMLTV replaces filler and keeps ids/escaping', async () => {
  const result = await refreshNow({
    sources: ['memory://epg-fixture'],
    channels: OUR_CHANNELS,
    loadSource: async () => FIXTURE,
  });

  assert.equal(result.matched, 2);
  assert.equal(result.programmes, 4);
  assert.equal(result.channels, 4);
  assert.deepEqual(result.errors, []);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'memory://epg-fixture');
  assert.equal(result.sources[0].error, undefined);
  assert.ok(result.fetchedAt > 0);

  const guide = getGuide();
  assert.equal(guide.byChannelId.size, 2);
  assert.equal(guide.byChannelId.get(1).sourceChannelId, 'SkySp.Fball.uk');
  assert.equal(guide.byChannelId.get(1).icon, 'https://example.test/logos/skysportsfootball.png');
  assert.equal(guide.byChannelId.get(1).programmes.length, 3);

  const stats = getStats();
  assert.equal(stats.matched, 2);
  assert.equal(stats.programmes, 4);
  assert.equal(stats.sources, 1);
  assert.ok(stats.ageMs !== null);
  assert.ok(!JSON.stringify(stats).includes('memory://'), 'stats never expose source URLs');

  const out = buildXmltv({ channels: OUR_CHANNELS, events: [], nowMs: NOW, guide });

  // 4 real programmes + 4 blocks each for the two unmatched channels.
  assert.equal(out.channels, 4);
  assert.equal(out.programmes, 12);
  assert.equal(out.truncated, false);

  assert.ok(out.body.includes('<title>Football &amp; More &lt;Live&gt;</title>'));
  assert.ok(out.body.includes('<desc>O&apos;Reilly &amp; co present the big match.</desc>'));
  assert.ok(out.body.includes('<category>Football</category>'));
  assert.ok(out.body.includes('<title>Bundesliga Live</title>'));
  assert.ok(out.body.includes('<episode-num system="xmltv_ns">0.1/2</episode-num>'));
  assert.ok(out.body.includes('https://example.test/logos/skysportsfootball.png'));

  // Matched channels no longer show the channel name as the title; unmatched
  // channels keep the 24/7 filler blocks.
  assert.ok(!out.body.includes('<title>Sky Sports Football UK</title>'));
  assert.ok(!out.body.includes('<title>Sky Sports Main Event DE</title>'));
  assert.ok(out.body.includes('<title>Totally Unmatched Channel</title>'));
  assert.ok(out.body.includes('<desc>24/7 channel</desc>'));
  assert.ok(!out.body.includes('Croatian League'));

  // Playlist tvg-id contract is unchanged.
  assert.ok(out.body.includes('channel="dlhd-1"'));
  assert.ok(out.body.includes('channel="dlhd-2"'));
  assert.ok(out.body.includes('channel="dlhd-3"'));
  assert.ok(out.body.includes('id="dlhd-1"'));
});

test('epg revision: changes when the guide changes, not on failure', async () => {
  const before = epgRevision();
  const changed = FIXTURE.replace('Bundesliga Live', 'Bundesliga Extra');

  const result = await refreshNow({
    sources: ['memory://epg-fixture-2'],
    channels: OUR_CHANNELS,
    loadSource: async () => changed,
  });
  assert.equal(result.programmes, 4);
  assert.ok(epgRevision() > before, 'new guide data bumps the revision');

  const revision = epgRevision();
  const failed = await refreshNow({
    sources: ['memory://epg-failure'],
    channels: OUR_CHANNELS,
    loadSource: async () => {
      throw new Error('synthetic source failure');
    },
  });
  assert.equal(failed.matched, 2, 'stale guide is kept on failure');
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0].message, 'synthetic source failure');
  assert.equal(epgRevision(), revision, 'a failed refresh does not bump the revision');
});

test('epg live: default epgshare01 source matches the catalogue', { skip: OFFLINE ? 'OFFLINE=1' : false, timeout: 240_000 }, async (t) => {
  const catalog = await import('../src/catalog/index.js');
  await catalog.refreshNow();

  const result = await refreshNow();
  const names = new Map(catalog.getChannels().map((channel) => [channel.id, channel.name]));
  const guide = getGuide();

  const samples = [];
  for (const [id, entry] of guide.byChannelId) {
    if (samples.length >= 5) break;
    samples.push(`${names.get(id) ?? id} -> ${entry.sourceChannelId}`);
  }
  t.diagnostic(
    `matched ${result.matched} channels, ${result.programmes} programmes from ${result.sources.length} source(s)`,
  );
  for (const sample of samples) t.diagnostic(sample);

  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.ok(result.channels >= 400, `parsed ${result.channels} EPG channels`);
  assert.ok(result.matched >= 40, `matched only ${result.matched} channels`);
  assert.ok(result.programmes > 1000, `kept only ${result.programmes} programmes`);

  const serbian = catalog
    .getChannels()
    .find((channel) => channel.name === 'Arena Sport 1 Serbia');
  if (serbian) {
    assert.equal(
      guide.byChannelId.get(serbian.id),
      undefined,
      'Arena Sport 1 Serbia must never map to a Croatian feed',
    );
  }
});
