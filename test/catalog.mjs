/**
 * Live catalogue tests (the real site is scraped; set OFFLINE=1 to skip).
 *
 *   node --test test/catalog.mjs
 *   OFFLINE=1 node --test test/catalog.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getChannels,
  getEvents,
  getStats,
  refreshNow,
} from '../src/catalog/index.js';

const OFFLINE = process.env.OFFLINE === '1';
const YEAR_2026_START = Date.UTC(2026, 0, 1);
const YEAR_2026_END = Date.UTC(2027, 0, 1);

test('catalogue: channels and events scraped from the live site', { skip: OFFLINE ? 'OFFLINE=1' : false, timeout: 120_000 }, async () => {
  const stats = await refreshNow();

  assert.equal(
    stats.errors.length,
    0,
    `refresh reported errors: ${JSON.stringify(stats.errors)}`,
  );
  assert.ok(stats.fetchedAt > 0, 'snapshot should have a fetchedAt timestamp');

  const channels = getChannels();
  assert.ok(channels.length > 800, `expected > 800 channels, got ${channels.length}`);
  assert.ok(
    channels.every((channel) => Number.isInteger(channel.id)),
    'every channel id must be a number',
  );
  assert.ok(
    channels.every((channel) => typeof channel.name === 'string' && channel.name.trim().length > 0),
    'every channel must have a non-empty name',
  );
  const uniqueIds = new Set(channels.map((channel) => channel.id));
  assert.equal(uniqueIds.size, channels.length, 'channel ids must be de-duplicated');
  assert.ok(
    channels.every((channel, index) => index === 0 || channels[index - 1].name.localeCompare(channel.name, 'en', { sensitivity: 'base' }) <= 0),
    'channels should be sorted by name',
  );

  const events = getEvents();
  assert.ok(events.length >= 50, `expected at least 50 events, got ${events.length}`);
  assert.ok(
    events.every((event) => Number.isFinite(event.startMs)),
    'every event needs a numeric startMs',
  );
  assert.ok(
    events.every((event) => Number.isInteger(event.id) && event.id > 0),
    'every event needs a stable numeric id',
  );

  const inSaneRange = events.filter(
    (event) => event.startMs >= YEAR_2026_START && event.startMs < YEAR_2026_END,
  );
  assert.ok(
    inSaneRange.length >= 50,
    `expected >= 50 events in 2026, got ${inSaneRange.length}`,
  );
  assert.ok(
    events.some((event) => Array.isArray(event.channelIds) && event.channelIds.length > 0),
    'at least one event must reference a channel',
  );
  assert.ok(
    events.every(
      (event) =>
        Array.isArray(event.channelIds) &&
        event.channelIds.length === event.channelNames.length,
    ),
    'channelIds and channelNames must line up',
  );
  assert.ok(
    events.every((event) => event.endMs === event.startMs + 3 * 60 * 60 * 1000),
    'events default to a 3h duration',
  );

  assert.equal(getStats().channels, channels.length);
  assert.ok(getStats().stats.eventBlocks >= events.length);

  console.log(
    `catalogue live: ${channels.length} channels (${stats.stats.channelDuplicates} dupes), ` +
      `${events.length} events, ${stats.stats.eventSkipped} skipped`,
  );
});
