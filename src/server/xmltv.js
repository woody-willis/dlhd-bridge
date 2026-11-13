/**
 * XMLTV 0.1 generation from the catalogue snapshot.
 *
 * One <channel> per playlist entry (24/7 channels and event virtual channels),
 * 4x6h <programme> blocks per 24/7 channel, and one programme per event.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const GUIDE_PAST_MS = 6 * 60 * 60 * 1000;
const GUIDE_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROGRAMMES = 30000;
const CONTENT_TYPE = 'application/xml; charset=utf-8';

const XML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
});

function clean(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** XML-escape text and attribute values. */
export function escapeXml(value) {
  return clean(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

/** XMLTV time: `YYYYMMDDHHMMSS +0000`. */
export function formatXmltvTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  );
}

function channelId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Playable channel targets for an event, keeping names aligned with ids.
 * Id 0 is the site's placeholder link (`/watch.php?id=00`) and never plays.
 */
function eventChannels(event) {
  const out = [];
  const rawIds = Array.isArray(event?.channelIds) ? event.channelIds : [];
  const rawNames = Array.isArray(event?.channelNames) ? event.channelNames : [];
  for (let i = 0; i < rawIds.length; i++) {
    const id = channelId(rawIds[i]);
    if (id === null || id <= 0) continue;
    if (out.some((entry) => entry.id === id)) continue;
    out.push({ id, name: rawNames[i] });
  }
  return out;
}

function compareChannels(a, b) {
  return (
    String(a.group ?? '').localeCompare(String(b.group ?? ''), 'en', { sensitivity: 'base' }) ||
    String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', { sensitivity: 'base' }) ||
    Number(a.id) - Number(b.id)
  );
}

function compareEvents(a, b) {
  return (
    Number(a.startMs) - Number(b.startMs) ||
    String(a.title ?? '').localeCompare(String(b.title ?? ''), 'en', { sensitivity: 'base' }) ||
    Number(a.id) - Number(b.id)
  );
}

function validEvent(event) {
  return (
    event &&
    Number.isFinite(Number(event.startMs)) &&
    Number.isFinite(Number(event.endMs)) &&
    Number(event.endMs) > Number(event.startMs)
  );
}

/**
 * Guide programmes for one channel inside [now-6h, now+7d], clamped, sorted
 * and de-duplicated by start time.
 *
 * @param {{programmes?:Array}|undefined} entry
 * @param {number} now
 * @returns {Array<object>}
 */
function guideWindow(entry, now) {
  if (!entry || !Array.isArray(entry.programmes) || entry.programmes.length === 0) return [];
  const from = now - GUIDE_PAST_MS;
  const to = now + GUIDE_FUTURE_MS;
  const out = [];
  const seen = new Set();
  for (const programme of entry.programmes) {
    const startMs = Number(programme?.startMs);
    const stopMs = Number(programme?.stopMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) continue;
    if (stopMs <= from || startMs >= to) continue;
    if (seen.has(startMs)) continue;
    seen.add(startMs);
    out.push({
      ...programme,
      startMs: Math.max(startMs, from),
      stopMs: Math.min(stopMs, to),
    });
  }
  out.sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
  return out;
}

/** One `<programme>` line from an external guide entry. */
function guideProgrammeXml(tvgId, programme, fallbackIcon) {
  const parts = [
    `  <programme start="${formatXmltvTime(programme.startMs)}" ` +
      `stop="${formatXmltvTime(programme.stopMs)}" channel="${tvgId}">`,
    `<title>${escapeXml(programme.title)}</title>`,
  ];
  if (programme.category) parts.push(`<category>${escapeXml(programme.category)}</category>`);
  if (programme.desc) parts.push(`<desc>${escapeXml(programme.desc)}</desc>`);
  if (programme.episode && programme.episode.value) {
    const system = programme.episode.system
      ? ` system="${escapeXml(programme.episode.system)}"`
      : '';
    parts.push(`<episode-num${system}>${escapeXml(programme.episode.value)}</episode-num>`);
  }
  const icon = programme.icon || fallbackIcon || '';
  parts.push(`<icon src="${escapeXml(icon)}"/>`);
  parts.push('</programme>');
  return parts.join('');
}

/**
 * @param {{
 *   channels?: Array<{id:number,name:string,group:string}>,
 *   events?: Array<object>,
 *   nowMs?: number,
 *   maxProgrammes?: number,
 *   excludeChannelIds?: Array<number|string>,
 *   guide?: {byChannelId?: Map<number, {programmes:Array, icon?:string, sourceChannelId:string}>},
 * }} [options]
 * @returns {{body:string, contentType:string, channels:number, programmes:number, truncated:boolean}}
 */
export function buildXmltv(options = {}) {
  const channels = Array.isArray(options.channels) ? options.channels : [];
  const events = Array.isArray(options.events) ? options.events : [];
  const now = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const capRaw = Number(options.maxProgrammes);
  const cap =
    Number.isInteger(capRaw) && capRaw > 0 ? capRaw : MAX_PROGRAMMES;
  const guideMap = options.guide?.byChannelId instanceof Map ? options.guide.byChannelId : null;

  const channelLines = [];
  const programmeLines = [];
  const seenChannelIds = new Set();
  const seenEventIds = new Set();
  let programmeCount = 0;
  let truncated = false;

  const addProgramme = (xml) => {
    if (programmeCount >= cap) {
      truncated = true;
      return false;
    }
    programmeLines.push(xml);
    programmeCount++;
    return true;
  };

  const excluded = new Set(
    (Array.isArray(options.excludeChannelIds) ? options.excludeChannelIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value)),
  );

  const sortedChannels = [...channels].filter(Boolean).sort(compareChannels);
  const blockStart = Math.floor(now / SIX_HOURS_MS) * SIX_HOURS_MS;

  for (const channel of sortedChannels) {
    const id = channelId(channel.id);
    if (id === null || excluded.has(id)) continue;
    const tvgId = `dlhd-${id}`;
    if (seenChannelIds.has(tvgId)) continue;
    seenChannelIds.add(tvgId);

    const name = clean(channel.name) || `Channel ${id}`;
    const guideEntry = guideMap ? guideMap.get(id) : undefined;
    const external = guideWindow(guideEntry, now);
    const iconSrc = external.length > 0 && guideEntry?.icon ? escapeXml(guideEntry.icon) : '';
    channelLines.push(
      `  <channel id="${tvgId}"><display-name>${escapeXml(name)}</display-name><icon src="${iconSrc}"/></channel>`,
    );

    if (external.length > 0) {
      for (const programme of external) {
        addProgramme(guideProgrammeXml(tvgId, programme, guideEntry.icon));
      }
      continue;
    }

    // 4 x 6h blocks starting at the current 6h boundary (no guide data).
    for (let i = 0; i < 4; i++) {
      const start = blockStart + i * SIX_HOURS_MS;
      const stop = start + SIX_HOURS_MS;
      addProgramme(
        `  <programme start="${formatXmltvTime(start)}" stop="${formatXmltvTime(stop)}" ` +
          `channel="${tvgId}"><title>${escapeXml(name)}</title>` +
          `<desc>24/7 channel</desc></programme>`,
      );
    }
  }

  for (const event of [...events].filter(validEvent).sort(compareEvents)) {
    const id = Number(event.id);
    if (!Number.isInteger(id) || id < 0) continue;
    if (seenEventIds.has(id)) continue;
    seenEventIds.add(id);

    const start = Number(event.startMs);
    const stop = Math.min(Number(event.endMs), start + SIX_HOURS_MS);
    if (!(stop > start)) continue;
    if (stop <= now - STALE_AFTER_MS) continue;

    const tvgId = `dlhd-ev-${id}`;
    const targets = eventChannels(event).filter((target) => !excluded.has(target.id));
    if (targets.length === 0) continue; // no playable channel
    const title = clean(event.title) || `Event ${id}`;
    const category = clean(event.category) || 'Events';
    const names = targets.map((target) => clean(target.name)).filter(Boolean);
    const desc = names.length > 0 ? names.join(', ') : 'Scheduled event';

    if (!seenChannelIds.has(tvgId)) {
      seenChannelIds.add(tvgId);
      channelLines.push(
        `  <channel id="${tvgId}"><display-name>${escapeXml(title)}</display-name><icon src=""/></channel>`,
      );
    }

    addProgramme(
      `  <programme start="${formatXmltvTime(start)}" stop="${formatXmltvTime(stop)}" ` +
        `channel="${tvgId}"><title>${escapeXml(title)}</title>` +
        `<category>${escapeXml(category)}</category>` +
        `<desc>${escapeXml(desc)}</desc></programme>`,
    );
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="dlhd-bridge">',
    ...channelLines,
    ...programmeLines,
    '</tv>',
    '',
  ].join('\n');

  return {
    body,
    contentType: CONTENT_TYPE,
    channels: channelLines.length,
    programmes: programmeCount,
    truncated,
  };
}

export default { buildXmltv, formatXmltvTime, escapeXml, MAX_PROGRAMMES };
