/**
 * Tolerant, regex-based extraction from thedaddy.li HTML.
 *
 * The public API is exactly `parseChannels(html)` and `parseEvents(html)`;
 * both return plain arrays. For the catalogue layer each returned array also
 * carries a non-enumerable `.stats` object (counts of malformed / skipped
 * rows) so refresh stats can be reported without widening the exports.
 *
 * Every helper is defensive: bad markup yields fewer items plus a stat, never
 * an exception. No HTML parser and no eval/new Function is used.
 */

const MONTHS = Object.freeze({
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
});

const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000;

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
});

function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripTags(input) {
  return String(input).replace(/<[^>]*>/g, ' ');
}

function cleanText(input) {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}

function getAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(tag).match(re);
  if (!match) return '';
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

function attachStats(items, stats) {
  Object.defineProperty(items, 'stats', {
    value: stats,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return items;
}

/**
 * Extract the 24/7 channel directory.
 *
 * Verified markup (2026-11-10, /24-7-channels.php):
 *   <a class="card"
 *      href="/watch.php?id=51"
 *      data-title="abc usa"
 *      data-first="A">
 *     <div class="card__title">ABC USA</div>...
 *
 * Returns `[{id, name, group}]`. Duplicate ids are intentionally preserved so
 * the catalogue layer can de-duplicate and count them (811 appears twice).
 *
 * @param {string} html
 * @returns {Array<{id:number,name:string,group:string}>}
 */
export function parseChannels(html) {
  const stats = {
    anchors: 0,
    parsed: 0,
    skipped: 0,
    missingName: 0,
    malformed: 0,
  };
  const items = [];
  if (typeof html !== 'string' || html.length === 0) return attachStats(items, stats);

  const anchorRe = /<a\b[^>]*>/gi;
  const anchors = [];
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const tag = match[0];
    if (!/\bclass\s*=\s*["'][^"']*\bcard\b[^"']*["']/i.test(tag)) continue;
    if (!/href\s*=\s*["'][^"']*\/watch\.php\?/i.test(tag)) continue;
    anchors.push({ index: match.index, end: anchorRe.lastIndex, tag });
  }

  stats.anchors = anchors.length;

  for (let i = 0; i < anchors.length; i++) {
    const { index, end, tag } = anchors[i];
    const href = getAttr(tag, 'href');
    const idMatch = href.match(/[?&]id=(\d+)/);
    if (!idMatch) {
      stats.malformed++;
      continue;
    }

    const id = Number.parseInt(idMatch[1], 10);
    if (!Number.isInteger(id) || id < 0) {
      stats.malformed++;
      continue;
    }

    // Look for the title block before the next card anchor so a missing title
    // cannot silently borrow the next channel's name.
    const nextIndex = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const region = html.slice(end, Math.min(nextIndex, end + 2000));
    const titleMatch = region.match(
      /<div\b[^>]*class\s*=\s*["'][^"']*\bcard__title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );

    let name = titleMatch ? cleanText(titleMatch[1]) : '';
    if (!name) name = cleanText(getAttr(tag, 'data-title'));
    if (!name) {
      name = `Channel ${id}`;
      stats.missingName++;
    }

    const group = cleanText(getAttr(tag, 'data-first')) || '#';
    items.push({ id, name, group });
    stats.parsed++;
  }

  stats.skipped = stats.anchors - stats.parsed;
  return attachStats(items, stats);
}

function parseDayTitle(text) {
  if (!text) return null;
  const match = String(text).match(
    /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/,
  );
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = MONTHS[match[2].toLowerCase()];
  const year = Number.parseInt(match[3], 10);
  if (!Number.isInteger(day) || month === undefined || !Number.isInteger(year)) return null;
  if (day < 1 || day > 31 || year < 2000 || year > 2100) return null;

  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date.getTime();
}

function parseTime(text) {
  const match = String(text).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60 + minutes) * 60 * 1000;
}

/** Stable, non-cryptographic 32-bit id derived from the event content. */
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function parseChannelsInEvent(block, stats) {
  const channelIds = [];
  const channelNames = [];
  const anchorRe = /<a\b[^>]*>/gi;
  let match;
  while ((match = anchorRe.exec(block)) !== null) {
    const tag = match[0];
    const href = getAttr(tag, 'href');
    const idMatch = href.match(/(?:^|\/)watch\.php\?id=(\d+)/);
    if (!idMatch) continue;
    const id = Number.parseInt(idMatch[1], 10);
    if (!Number.isInteger(id) || id < 0) {
      stats.badChannelLinks++;
      continue;
    }
    let name = cleanText(getAttr(tag, 'title'));
    if (!name) {
      // Fall back to the anchor text.
      const close = block.indexOf('</a>', anchorRe.lastIndex);
      const rawText =
        close > anchorRe.lastIndex ? block.slice(anchorRe.lastIndex, close) : '';
      name = cleanText(rawText);
    }
    if (!name) name = cleanText(getAttr(tag, 'data-ch')) || `Channel ${id}`;

    // Preserve order, drop exact duplicate ids within one event.
    if (channelIds.includes(id)) continue;
    channelIds.push(id);
    channelNames.push(name);
  }
  return { channelIds, channelNames };
}

/**
 * Extract the schedule from the homepage (or an `index.php?cat=` page).
 *
 * Walks the document in order, tracking the current day title and category
 * header, and emitting one item per `.schedule__event`. Times are UK GMT and
 * are interpreted as UTC (`TZ=UTC`). Events without a resolvable date or time
 * are skipped and counted in `.stats.skipped`.
 *
 * @param {string} html
 * @returns {Array<{id:number,title:string,category:string,startMs:number,endMs:number,channelIds:number[],channelNames:string[],day:string,time:string}>}
 */
export function parseEvents(html) {
  const stats = {
    blocks: 0,
    parsed: 0,
    skipped: 0,
    missingTitle: 0,
    missingTime: 0,
    unresolvedDate: 0,
    badChannelLinks: 0,
  };
  const items = [];
  if (typeof html !== 'string' || html.length === 0) return attachStats(items, stats);

  // One pass that records every structural marker in document order.
  const markerRe =
    /<div\b[^>]*class\s*=\s*["'][^"']*\bschedule__dayTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>|<div\b[^>]*class\s*=\s*["'][^"']*\bschedule__catHeader\b[^"']*["'][^>]*>[\s\S]{0,400}?<div\b[^>]*class\s*=\s*["'][^"']*\bcard__meta\b[^"']*["'][^>]*>([\s\S]*?)<\/div>|<div\b[^>]*class\s*=\s*["'][^"']*\bschedule__event\b[^"']*["'][^>]*>/gi;

  const markers = [];
  let match;
  while ((match = markerRe.exec(html)) !== null) {
    const isDay = match[1] !== undefined;
    const isCategory = !isDay && match[2] !== undefined;
    markers.push({
      index: match.index,
      contentStart: markerRe.lastIndex,
      kind: isDay ? 'day' : isCategory ? 'category' : 'event',
      text: isDay ? match[1] : isCategory ? match[2] : '',
    });
  }

  let currentDayMs = null;
  let currentDayText = '';
  let currentCategory = '';

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (marker.kind === 'day') {
      currentDayMs = parseDayTitle(cleanText(marker.text));
      currentDayText = cleanText(marker.text);
      continue;
    }
    if (marker.kind === 'category') {
      currentCategory = cleanText(marker.text);
      continue;
    }

    stats.blocks++;
    const nextIndex = i + 1 < markers.length ? markers[i + 1].index : html.length;
    const block = html.slice(marker.contentStart, nextIndex);

    const timeMatch = block.match(/\bdata-time\s*=\s*["'](\d{1,2}:\d{2})["']/i);
    const timeText = timeMatch ? timeMatch[1] : '';
    const timeOffset = parseTime(timeText);
    if (timeOffset === null) {
      stats.missingTime++;
      stats.skipped++;
      continue;
    }

    const titleMatch =
      block.match(
        /<span\b[^>]*class\s*=\s*["'][^"']*\bschedule__eventTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      ) || block.match(/\bdata-title\s*=\s*"([^"]*)"/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : '';
    if (!title) {
      stats.missingTitle++;
      stats.skipped++;
      continue;
    }

    if (currentDayMs === null) {
      stats.unresolvedDate++;
      stats.skipped++;
      continue;
    }

    const startMs = currentDayMs + timeOffset;
    const endMs = startMs + DEFAULT_EVENT_DURATION_MS;
    const { channelIds, channelNames } = parseChannelsInEvent(block, stats);

    items.push({
      // Stable across refreshes and independent of row order.
      id: fnv1a(`${currentDayText}|${timeText}|${title}`) || 1,
      title,
      category: currentCategory || 'Events',
      startMs,
      endMs,
      channelIds,
      channelNames,
      day: currentDayText,
      time: timeText,
    });
    stats.parsed++;
  }

  return attachStats(items, stats);
}

/**
 * Some pages link events to /stream/stream-<N>.php instead of /watch.php?id=N.
 * The current schedule does not, so this helper is intentionally internal. It
 * exists so callers can upgrade event channel links when the markup changes,
 * and it degrades to an empty map when no such links exist.
 */
function parseEventStreams(html) {
  const streams = new Map();
  if (typeof html !== 'string') return streams;
  const re = /\/stream\/stream-(\d+)\.php/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const id = Number.parseInt(match[1], 10);
    if (Number.isInteger(id) && !streams.has(id)) streams.set(id, `/stream/stream-${id}.php`);
  }
  return streams;
}
