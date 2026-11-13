/**
 * Tolerant XMLTV parser.
 *
 * The guide sources are large (20 MB+, ~40k programmes, some regional rippers
 * decode to 78 MB) and not always well-formed, so this is a byte scanner rather
 * than a DOM parser: it never throws, skips broken entries, and reports how
 * many it dropped.
 *
 * Parsing is split in two passes over the same document so the caller can learn
 * the channel list, match it, and only then build objects for the programmes of
 * matched channels. Everything else is skipped before any object or child text
 * is allocated.
 *
 * `text` may be a JS string (tests, callers that already hold text) or the
 * decompressed bytes. The refresh path passes the bytes: decoding a 78 MB
 * document to a string costs 78-154 MB on its own (UTF-8 → UTF-16) and is the
 * dominant memory cost of a multi-source refresh.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/** Decode the XML entities that show up in XMLTV text (named, decimal, hex). */
export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const known = NAMED_ENTITIES[name.toLowerCase()];
    return known === undefined ? match : known;
  });
}

/**
 * Force a fresh, flat string.
 *
 * V8 keeps substrings (regex captures) as SlicedStrings that pin their parent.
 * Everything the guide retains goes through this, so a stored title/icon can
 * never keep a decoded document alive.
 */
function copyText(value) {
  return `\u0000${value}`.slice(1);
}

/** Strip CDATA wrappers, decode entities and collapse whitespace. */
function textOf(value) {
  return copyText(
    decodeEntities(String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

const ATTR_PATTERNS = new Map();
const TAG_PATTERNS = new Map();

function attrPattern(name) {
  let pattern = ATTR_PATTERNS.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
    ATTR_PATTERNS.set(name, pattern);
  }
  return pattern;
}

function attr(tag, name) {
  const match = attrPattern(name).exec(tag);
  if (!match) return '';
  const raw = match[2] ?? match[3] ?? '';
  // Attribute values are already trimmed in practice; only pay for the full
  // normalisation when there is something to normalise.
  if (!/[\s&<]/.test(raw)) return copyText(raw);
  return textOf(raw);
}

function childText(body, tag) {
  let pattern = TAG_PATTERNS.get(tag);
  if (!pattern) {
    pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
    TAG_PATTERNS.set(tag, pattern);
  }
  pattern.lastIndex = 0;
  const match = pattern.exec(body);
  return match ? textOf(match[1]) : '';
}

function firstIcon(xml) {
  const match = /<icon\b[^>]*>/i.exec(xml);
  if (!match) return '';
  return attr(match[0], 'src');
}

/**
 * Parse an XMLTV timestamp (`YYYYMMDDHHMMSS +HHMM`) as UTC milliseconds.
 * A missing offset is treated as UTC; anything malformed returns NaN.
 *
 * @param {string} value
 * @returns {number}
 */
export function parseXmltvTime(value) {
  const match = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(
    String(value ?? ''),
  );
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, offset] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || 0),
  );
  if (!Number.isFinite(ms)) return NaN;
  if (!offset) return ms;
  const sign = offset[0] === '-' ? -1 : 1;
  const offsetMs = (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) * 60_000;
  return ms - sign * offsetMs;
}

/** Longest retained description; XMLTV writers only need a summary. */
export const MAX_DESC_CHARS = 300;

const GT = 0x3e; // >
const SLASH = 0x2f; // /
const DQUOTE = 0x22; // "
const SQUOTE = 0x27; // '
const EQUALS = 0x3d; // =
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

function isTagBoundary(byte) {
  return byte === SPACE || byte === TAB || byte === LF || byte === CR || byte === GT || byte === SLASH;
}

function isSpace(byte) {
  return byte === SPACE || byte === TAB || byte === LF || byte === CR;
}

/** The document as bytes: a string is UTF-8 encoded once, a Buffer used as-is. */
function documentOf(text) {
  if (Buffer.isBuffer(text)) return text;
  if (text instanceof Uint8Array) return Buffer.from(text.buffer, text.byteOffset, text.byteLength);
  return Buffer.from(String(text ?? ''), 'utf8');
}

/** Index of an open tag (`<name` at a tag boundary), or -1. */
function indexOfOpen(buf, name, from) {
  const needle = `<${name}`;
  let at = from;
  for (;;) {
    at = buf.indexOf(needle, at);
    if (at < 0) return -1;
    if (isTagBoundary(buf[at + needle.length])) return at;
    at += needle.length;
  }
}

/**
 * Locate the `channel` attribute inside an open tag. Returns the value's byte
 * range (`start === end === -1` when absent), so the caller can compare bytes
 * without building a string for every programme in the document.
 */
function channelAttrRange(buf, start, end) {
  for (let i = start + 1; i + 7 < end; i++) {
    const c = buf[i];
    if ((c !== 0x63 && c !== 0x43) || !isSpace(buf[i - 1])) continue; // c / C
    const h = buf[i + 1] | 0x20;
    const a = buf[i + 2] | 0x20;
    const n1 = buf[i + 3] | 0x20;
    const n2 = buf[i + 4] | 0x20;
    const e = buf[i + 5] | 0x20;
    const l = buf[i + 6] | 0x20;
    if (h !== 0x68 || a !== 0x61 || n1 !== 0x6e || n2 !== 0x6e || e !== 0x65 || l !== 0x6c) {
      continue;
    }
    let j = i + 7;
    while (j < end && isSpace(buf[j])) j++;
    if (buf[j] !== EQUALS) continue;
    j++;
    while (j < end && isSpace(buf[j])) j++;
    const quote = buf[j];
    if (quote !== DQUOTE && quote !== SQUOTE) continue;
    const valueStart = j + 1;
    const valueEnd = buf.indexOf(quote, valueStart);
    if (valueEnd < 0 || valueEnd > end) return [-1, -1];
    return [valueStart, valueEnd];
  }
  return [-1, -1];
}

/** FNV-1a over a byte range, used only as the cache key for channel ids. */
function hashRange(buf, start, end) {
  let hash = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Wanted-channel check without allocating for the common case.
 *
 * There are hundreds of programmes per channel, so decoding the attribute for
 * every one is pure garbage. The cache is keyed by the byte hash and verified
 * byte-for-byte, so a collision only costs a re-decode, never a wrong match.
 */
function channelMatcher(wantedIds) {
  if (wantedIds == null) return () => true;
  const wanted = wantedIds instanceof Set ? wantedIds : new Set(wantedIds);
  const cache = new Map();
  return (buf, start, end) => {
    if (start < 0) return false;
    const hash = hashRange(buf, start, end);
    const length = end - start;
    const cached = cache.get(hash);
    if (cached && cached.length === length && buf.compare(cached.bytes, 0, length, start, end) === 0) {
      return cached.wanted;
    }
    const raw = buf.toString('utf8', start, end);
    const normalised = /[\s&]/.test(raw) ? textOf(raw) : raw;
    const hit = wanted.has(normalised);
    cache.set(hash, { bytes: Buffer.from(buf.subarray(start, end)), wanted: hit });
    return hit;
  };
}

function parseChannel(xml) {
  const open = /^<channel\b([^>]*)>/i.exec(xml);
  if (!open) return null;
  const id = attr(open[1], 'id');
  if (!id) return null;
  const names = [];
  for (const match of xml.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name\s*>/gi)) {
    const name = textOf(match[1]);
    if (name && !names.includes(name)) names.push(name);
  }
  return { id, names, icon: firstIcon(xml) };
}

/**
 * Build a programme from its already-matched channel and element body.
 * Only the fields the XMLTV writer emits are kept.
 */
function parseProgramme(channel, attrs, body) {
  const startMs = parseXmltvTime(attr(attrs, 'start'));
  const stopMs = parseXmltvTime(attr(attrs, 'stop'));
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) {
    return null;
  }
  const title = childText(body, 'title');
  if (!title) return null;

  const episodeMatch = /<episode-num\b([^>]*)>([\s\S]*?)<\/episode-num\s*>/i.exec(body);
  const episodeValue = episodeMatch ? textOf(episodeMatch[2]) : '';
  const episode = episodeValue
    ? { system: attr(episodeMatch[1], 'system') || 'xmltv_ns', value: episodeValue }
    : null;

  const desc = childText(body, 'desc');
  return {
    startMs,
    stopMs,
    channel,
    title,
    desc: desc.length > MAX_DESC_CHARS ? desc.slice(0, MAX_DESC_CHARS) : desc,
    category: childText(body, 'category'),
    icon: firstIcon(body),
    episode,
  };
}

/** Old single-pass element bound (`{0,4096}` channel, `{0,16384}` programme). */
const CHANNEL_BODY_MAX = 4096;
const PROGRAMME_BODY_MAX = 16384;

/**
 * Pass 1: every `<channel>` in the document.
 *
 * @param {string|Buffer|Uint8Array} text raw XMLTV document
 * @returns {{channels: Array<{id:string,names:string[],icon:string}>,
 *   stats: {channels:number, skippedChannels:number}}}
 */
export function parseXmltvChannels(text) {
  const buf = documentOf(text);
  const channels = [];
  const stats = { channels: 0, skippedChannels: 0 };
  if (buf.length === 0) return { channels, stats };

  const seen = new Set();
  let from = 0;
  for (;;) {
    const start = indexOfOpen(buf, 'channel', from);
    if (start < 0) break;
    const openEnd = buf.indexOf(GT, start);
    if (openEnd < 0) break;
    // Bounded bodies keep an unclosed tag from swallowing the document.
    const closeStart = buf.indexOf('</channel', openEnd);
    const closeEnd = closeStart >= 0 ? buf.indexOf(GT, closeStart) : -1;
    if (closeStart < 0 || closeEnd < 0 || closeStart - openEnd > CHANNEL_BODY_MAX) {
      stats.skippedChannels++;
      from = openEnd + 1;
      continue;
    }
    const channel = parseChannel(buf.toString('utf8', start, closeEnd + 1));
    from = closeEnd + 1;
    if (!channel || seen.has(channel.id)) {
      stats.skippedChannels++;
      continue;
    }
    seen.add(channel.id);
    channels.push(channel);
    stats.channels++;
  }
  return { channels, stats };
}

/**
 * Pass 2: programmes for the wanted EPG channel ids only.
 *
 * The channel attribute is read from the open tag's bytes; anything outside
 * `wantedIds` is skipped before the element body is decoded or any object is
 * created.
 *
 * @param {string|Buffer|Uint8Array} text raw XMLTV document
 * @param {Set<string>|Iterable<string>|null|undefined} wantedIds
 *   `null`/`undefined` keeps every programme (used by the `parseXmltv` wrapper).
 * @returns {{programmes: Array<object>,
 *   stats: {programmes:number, skippedProgrammes:number, ignoredProgrammes:number}}}
 */
export function parseProgrammes(text, wantedIds) {
  const buf = documentOf(text);
  const isWanted = channelMatcher(wantedIds);
  const programmes = [];
  const stats = { programmes: 0, skippedProgrammes: 0, ignoredProgrammes: 0 };
  if (buf.length === 0) return { programmes, stats };

  let from = 0;
  for (;;) {
    const start = indexOfOpen(buf, 'programme', from);
    if (start < 0) break;
    const openEnd = buf.indexOf(GT, start);
    if (openEnd < 0) break;

    const [valueStart, valueEnd] = channelAttrRange(buf, start, openEnd);
    if (valueStart < 0) {
      stats.skippedProgrammes++;
      from = openEnd + 1;
      continue;
    }
    if (!isWanted(buf, valueStart, valueEnd)) {
      stats.ignoredProgrammes++;
      from = openEnd + 1;
      continue;
    }
    const channel = buf.toString('utf8', valueStart, valueEnd);
    if (!channel) {
      stats.skippedProgrammes++;
      from = openEnd + 1;
      continue;
    }

    const bodyStart = openEnd + 1;
    const closeStart = buf.indexOf('</programme', bodyStart);
    const closeEnd = closeStart >= 0 ? buf.indexOf(GT, closeStart) : -1;
    if (closeStart < 0 || closeEnd < 0 || closeStart - bodyStart > PROGRAMME_BODY_MAX) {
      stats.skippedProgrammes++;
      from = bodyStart;
      continue;
    }
    const programme = parseProgramme(
      channel,
      buf.toString('utf8', start, openEnd + 1),
      buf.toString('utf8', bodyStart, closeStart),
    );
    from = closeEnd + 1;
    if (!programme) {
      stats.skippedProgrammes++;
      continue;
    }
    programmes.push(programme);
    stats.programmes++;
  }
  return { programmes, stats };
}

/**
 * Whole-document convenience wrapper (channels + every programme). The refresh
 * path uses the two passes instead so it can filter before allocating objects.
 *
 * @param {string|Buffer|Uint8Array} text raw XMLTV document
 * @returns {{
 *   channels: Array<{id:string,names:string[],icon:string}>,
 *   programmes: Array<object>,
 *   stats: {channels:number,programmes:number,skippedChannels:number,skippedProgrammes:number}
 * }}
 */
export function parseXmltv(text) {
  const document = documentOf(text);
  const channelPass = parseXmltvChannels(document);
  const programmePass = parseProgrammes(document, null);
  return {
    channels: channelPass.channels,
    programmes: programmePass.programmes,
    stats: {
      channels: channelPass.stats.channels,
      programmes: programmePass.stats.programmes,
      skippedChannels: channelPass.stats.skippedChannels,
      skippedProgrammes: programmePass.stats.skippedProgrammes,
    },
  };
}

export default {
  parseXmltv,
  parseXmltvChannels,
  parseProgrammes,
  parseXmltvTime,
  decodeEntities,
};
