/**
 * Environment parsing and shared constants.
 *
 * Everything here is read once at module load. Invalid values fail fast with a
 * descriptive Error rather than silently falling back to a surprising default.
 */

export const SITE = 'https://thedaddy.li';

/** Provider ids used on resolve() results and in stats. */
export const PROVIDER = Object.freeze({
  TOSSEQUIP: 'tossequip',
  FALLBACK: 'fallback',
  WIDEIPTV: 'wideiptv',
});

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function readInt(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: expected an integer, got ${JSON.stringify(raw)}`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`Invalid ${name}: ${value} is below the minimum ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`Invalid ${name}: ${value} is above the maximum ${max}`);
  }
  return value;
}

function readString(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function readBool(name, fallback) {
  const raw = readString(name, '');
  if (raw === '') return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`Invalid ${name}: expected a boolean, got ${JSON.stringify(raw)}`);
}

/**
 * EPG_SOURCES: comma/space separated URLs. `none`/`off` disables the feature.
 * The default is one public UK XMLTV file from epgshare01.online.
 */
function readEpgSources() {
  const defaultUrl = 'https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz';
  const raw = readString('EPG_SOURCES', defaultUrl);
  if (/^(none|off)$/i.test(raw)) return Object.freeze([]);
  const urls = raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of urls) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid EPG_SOURCES: ${JSON.stringify(value)} is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Invalid EPG_SOURCES: expected http(s), got ${parsed.protocol}`);
    }
  }
  return Object.freeze(urls);
}

function readBaseUrl() {
  const raw = readString('BASE_URL', '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid BASE_URL: ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid BASE_URL: expected http(s), got ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function readLogLevel() {
  const level = readString('LOG_LEVEL', 'info').toLowerCase();
  if (!LOG_LEVELS.has(level)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${JSON.stringify(level)} (expected one of ${[...LOG_LEVELS].join(', ')})`,
    );
  }
  return level;
}

export const config = Object.freeze({
  host: readString('HOST', '0.0.0.0'),
  port: readInt('PORT', 8080, { min: 0, max: 65535 }),
  baseUrl: readBaseUrl(),
  catalogRefreshMin: readInt('CATALOG_REFRESH_MIN', 10, { min: 1, max: 1440 }),
  eventWindowMin: readInt('EVENT_WINDOW_MIN', 120, { min: 0, max: 10080 }),
  excludeAdult: readBool('EXCLUDE_ADULT', true),
  resolveTtlSec: readInt('RESOLVE_TTL_SEC', 600, { min: 1, max: 86400 }),
  upstreamTimeoutMs: readInt('UPSTREAM_TIMEOUT_MS', 15000, { min: 100, max: 120000 }),
  epgSources: readEpgSources(),
  epgRefreshMin: readInt('EPG_REFRESH_MIN', 360, { min: 15, max: 10080 }),
  epgMaxBytes: readInt('EPG_MAX_BYTES', 83886080, { min: 1048576, max: 536870912 }),
  userAgent: readString('USER_AGENT', DEFAULT_USER_AGENT),
  logLevel: readLogLevel(),
  site: SITE,
});

export default config;
