/**
 * Exact-key channel matching between the bridge catalogue and an XMLTV source.
 *
 * Precision over recall: a wrong guide is worse than no guide, so there is no
 * fuzzy matching. Names are normalised to an abbreviation-expanded key and a
 * match only happens when the keys are identical and the country does not
 * contradict.
 */

/**
 * Trailing country words accepted in our channel names (and XMLTV id
 * suffixes). Anything not listed is treated as part of the channel name, so
 * "Arena Sport 1 Serbia" keeps `serbia` in its key and cannot collide with a
 * Croatian `Arena Sport 1`.
 */
const COUNTRY_BY_TOKEN = new Map([
  ['uk', 'uk'],
  ['usa', 'us'],
  ['us', 'us'],
  ['de', 'de'],
  ['germany', 'de'],
  ['italy', 'it'],
  ['it', 'it'],
  ['spain', 'es'],
  ['es', 'es'],
  ['france', 'fr'],
  ['fr', 'fr'],
  ['denmark', 'dk'],
  ['dk', 'dk'],
  ['nl', 'nl'],
  ['ireland', 'ie'],
  ['ie', 'ie'],
  ['poland', 'pl'],
  ['pl', 'pl'],
  ['greece', 'gr'],
  ['gr', 'gr'],
  ['portugal', 'pt'],
  ['pt', 'pt'],
  ['sweden', 'se'],
  ['sw', 'se'],
  ['se', 'se'],
  ['turkey', 'tr'],
  ['tr', 'tr'],
  ['pk', 'pk'],
  ['india', 'in'],
  ['in', 'in'],
  ['uae', 'ae'],
  ['ae', 'ae'],
  ['canada', 'ca'],
  ['ca', 'ca'],
  ['australia', 'au'],
  ['au', 'au'],
  ['argentina', 'ar'],
  ['ar', 'ar'],
  ['chile', 'cl'],
  ['cl', 'cl'],
  ['brazil', 'br'],
  ['br', 'br'],
  ['mexico', 'mx'],
  ['mx', 'mx'],
  ['japan', 'jp'],
  ['jp', 'jp'],
]);

const QUALITY_TOKENS = new Set([
  'hd',
  'fhd',
  'uhd',
  '4k',
  'sd',
  'hevc',
  'h265',
  'h264',
  'raw',
  'backup',
  'alt',
]);

const ABBREVIATIONS = new Map([
  ['sp', 'sports'],
  ['fball', 'football'],
  ['ev', 'event'],
  ['pl', 'premierleague'],
  ['boxoff', 'boxoffice'],
  ['tntsport', 'tntsports'],
  ['premiere', 'premiere'],
]);

/**
 * Split camel-case, lower-case, strip diacritics/punctuation and drop quality
 * suffixes. Returns the token list used by the key builder.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function normaliseName(name) {
  const text = String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  const tokens = [];
  for (const token of text.split(' ')) {
    if (!token || QUALITY_TOKENS.has(token)) continue;
    if (tokens.length > 0 && tokens[tokens.length - 1] === token) continue;
    tokens.push(token);
  }
  return tokens;
}

/**
 * Country code of a catalogue channel (`Sky Sports 1 DE` -> `de`). Unrecognised
 * trailing words are not treated as countries, so they stay in the key.
 *
 * @param {string} name
 * @returns {string} two-letter code or ''
 */
export function channelCountry(name) {
  const tokens = normaliseName(name);
  if (tokens.length < 2) return '';
  return COUNTRY_BY_TOKEN.get(tokens[tokens.length - 1]) ?? '';
}

/** Country code from an XMLTV channel id (`SkySp.Fball.uk` -> `uk`). */
export function epgCountry(id) {
  const raw = String(id ?? '');
  const dot = raw.lastIndexOf('.');
  if (dot < 0 || dot === raw.length - 1) return '';
  const suffix = raw.slice(dot + 1).toLowerCase();
  return COUNTRY_BY_TOKEN.get(suffix) ?? suffix;
}

/**
 * Expand abbreviations and join the tokens. `main + ev`/`main ev` collapse to
 * `mainevent` before the per-token expansion runs.
 */
function keyOf(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    if (token === 'main' && tokens[i + 1] === 'plus' && tokens[i + 2] === 'ev') {
      out.push('mainevent');
      i += 2;
      continue;
    }
    if (token === 'main' && tokens[i + 1] === 'ev') {
      out.push('mainevent');
      i += 1;
      continue;
    }
    token = ABBREVIATIONS.get(token) ?? token;
    if (out.length > 0 && out[out.length - 1] === token) continue;
    out.push(token);
  }
  return out.join('');
}

/** Stable choice among same-country duplicates: shortest id, then id order. */
function preferred(candidates) {
  return [...candidates].sort(
    (a, b) => String(a.id).length - String(b.id).length || String(a.id).localeCompare(String(b.id)),
  )[0];
}

function epgName(channel) {
  if (Array.isArray(channel?.names) && channel.names.length > 0 && channel.names[0]) {
    return channel.names[0];
  }
  // Ids such as `SkySp.Fball.uk` read as names once the dots become spaces.
  return String(channel?.id ?? '').replace(/\./g, ' ');
}

/**
 * Match our channels to EPG channels by exact normalised key.
 *
 * @param {Array<{id:number,name:string}>} ourChannels
 * @param {Array<{id:string,names:string[],icon?:string}>} epgChannels
 * @returns {{mapping: Map<number,string>, stats: object}}
 */
export function matchChannels(ourChannels = [], epgChannels = []) {
  const byKey = new Map();
  const stats = {
    ourChannels: Array.isArray(ourChannels) ? ourChannels.length : 0,
    epgChannels: 0,
    keys: 0,
    matched: 0,
    ambiguous: 0,
    countryMismatch: 0,
  };

  for (const channel of Array.isArray(epgChannels) ? epgChannels : []) {
    if (!channel || !channel.id) continue;
    const country = epgCountry(channel.id);
    let tokens = normaliseName(epgName(channel));
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && country && COUNTRY_BY_TOKEN.get(last) === country) {
      tokens = tokens.slice(0, -1);
    }
    const key = keyOf(tokens);
    if (!key) continue;
    stats.epgChannels++;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ id: channel.id, key, country });
  }
  stats.keys = byKey.size;

  const mapping = new Map();
  for (const channel of Array.isArray(ourChannels) ? ourChannels : []) {
    if (!channel || !Number.isInteger(Number(channel.id))) continue;
    const country = channelCountry(channel.name);
    let ourTokens = normaliseName(channel.name);
    if (ourTokens.length > 1 && country && COUNTRY_BY_TOKEN.get(ourTokens.at(-1)) === country) {
      ourTokens = ourTokens.slice(0, -1);
    }
    const key = keyOf(ourTokens);
    if (!key) continue;

    const candidates = byKey.get(key);
    if (!candidates || candidates.length === 0) continue;

    // Keep only candidates whose country is compatible with ours.
    let pool = country
      ? candidates.filter((c) => !c.country || c.country === country)
      : [...candidates];
    if (pool.length === 0) {
      stats.countryMismatch++;
      continue;
    }

    // With no country on our side, candidates from several countries are
    // genuinely ambiguous and are skipped. Same-country duplicates (e.g.
    // `SkySp Fball` and `SkySp Fball HD`) are the same feed under different
    // ids, so one is chosen deterministically.
    if (!country) {
      const countries = new Set(pool.map((c) => c.country).filter(Boolean));
      if (countries.size > 1) {
        stats.ambiguous++;
        continue;
      }
    }

    if (pool.length > 1) stats.ambiguous++;
    mapping.set(Number(channel.id), preferred(pool).id);
    stats.matched++;
  }

  return { mapping, stats };
}

export default { normaliseName, channelCountry, epgCountry, matchChannels };
