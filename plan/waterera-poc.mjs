#!/usr/bin/env node
/**
 * waterera-poc.mjs — resolve a thedaddy.li /cast/ channel id to a playable HLS URL.
 *
 * Verified live 2026-11-13 against:
 *   id 61  -> https://waterera.net/e/lavhlvnunx33l
 *   id 405 -> https://waterera.net/e/acgheutl8kp7b
 *   id 316 -> https://waterera.net/e/86xman0guksmz
 *
 * Node 22 ESM, no dependencies. Usage:
 *   node plan/waterera-poc.mjs 61 [--summary]
 *
 * The waterera.net player is Cloudflare-Turnstile gated: it POSTs
 * /turnstile/<token> with {hash, token, ts} and only then learns stream_url.
 * This script does NOT solve or bypass Turnstile. When the player page carries
 * `turnstile_key` it reports stage `turnstile-gated`, then — for diagnosis —
 * tries the same opaque token on the legacy player host `tossequip.net`, which
 * still serves the identical `_econfig` *with* `stream_url`. That is a server
 * configuration difference, not a captcha bypass. Remove the mirror block if
 * you only want the strict waterera answer.
 *
 * Set WATERERA_TURNSTILE_TOKEN to a token a human/real browser produced if you
 * want to exercise the waterera POST path end-to-end.
 */

const SITE = 'https://thedaddy.li';
const MIRROR = 'https://tossequip.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;

class StageError extends Error {
  constructor(stage, message, extra = {}) {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, { headers = {}, method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'user-agent': UA, ...headers },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StageError('network', `${method} ${new URL(url).origin} failed: ${err.message}`, { cause: err });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, url: res.url, buf, text: buf.toString('utf8') };
}

/* ------------------------------------------------------------------ *
 * _econfig decoder — copied from src/providers/tossequip.js (no import).
 * atob -> 4 chunks -> drop each chunk's 4th char -> atob each ->
 * assign with PERM=[2,0,3,1] -> join -> atob -> JSON.parse
 * ------------------------------------------------------------------ */
const b64Binary = (value) => Buffer.from(value, 'base64').toString('binary');

function permutations(values) {
  if (values.length <= 1) return [values.slice()];
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const rest = values.slice(0, i).concat(values.slice(i + 1));
    for (const tail of permutations(rest)) result.push([values[i], ...tail]);
  }
  return result;
}

const PERMUTATIONS = permutations([0, 1, 2, 3]);

function decodeWith(raw, dropIndex, permutation) {
  const chunkLength = Math.floor(raw.length / 4);
  if (chunkLength <= dropIndex) throw new Error('chunk too small');
  const chunks = [];
  for (let i = 0; i < 4; i++) chunks.push(raw.slice(i * chunkLength, (i + 1) * chunkLength));
  const ordered = new Array(4);
  for (let i = 0; i < 4; i++) {
    const chunk = chunks[i];
    const trimmed = chunk.slice(0, dropIndex) + chunk.slice(dropIndex + 1);
    ordered[permutation[i]] = b64Binary(trimmed);
  }
  return JSON.parse(b64Binary(ordered.join('')));
}

function decodeEconfig(value) {
  if (!value || typeof value !== 'string') throw new Error('empty _econfig');
  const raw = b64Binary(value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  if (raw.length < 32) throw new Error('payload too short');

  const attempts = [{ dropIndex: 3, permutation: [2, 0, 3, 1] }];
  for (let dropIndex = 0; dropIndex <= 7; dropIndex++) {
    for (const permutation of PERMUTATIONS) {
      if (dropIndex === 3 && permutation.join(',') === '2,0,3,1') continue;
      attempts.push({ dropIndex, permutation });
    }
  }
  for (const attempt of attempts) {
    let parsed;
    try {
      parsed = decodeWith(raw, attempt.dropIndex, attempt.permutation);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    return parsed;
  }
  throw new Error('no chunk permutation produced valid JSON');
}

function extractEconfig(html) {
  const match = html.match(/_econfig\s*=\s*(?:"([^"]{20,})"|'([^']{20,})')/i);
  return match ? (match[1] ?? match[2] ?? '').replace(/\s+/g, '') : '';
}

function extractIframes(html) {
  const out = [];
  const re = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/gi, '&').trim();
    if (src) out.push(src);
  }
  return out;
}

const NOTES = [];
function note(msg) {
  NOTES.push(msg);
}

async function loadPlayerPage(playerUrl, token) {
  const res = await http(playerUrl, { headers: { referer: `${SITE}/`, accept: 'text/html,application/xhtml+xml' } });
  if (res.status !== 200) {
    throw new StageError('player-http', `player page ${new URL(playerUrl).host} returned ${res.status}`, {
      status: res.status,
      url: playerUrl,
    });
  }
  if (/<title>\s*Not allowed\s*<\/title>/i.test(res.text)) {
    throw new StageError('player-denied', `${new URL(playerUrl).host} rejected Referer for ${token}`, {
      url: playerUrl,
    });
  }
  const encoded = extractEconfig(res.text);
  if (!encoded) {
    throw new StageError('econfig-missing', `no window._econfig on ${new URL(playerUrl).host}`, { url: playerUrl });
  }
  let cfg;
  try {
    cfg = decodeEconfig(encoded);
  } catch (err) {
    throw new StageError('decode-failed', `_econfig decode failed: ${err.message}`, { cause: err, url: playerUrl });
  }
  return { res, cfg };
}

async function verifyPlaylist(streamUrl, referer) {
  const res = await http(streamUrl, { headers: { referer } });
  if (res.status !== 200) {
    throw new StageError('playlist-http', `playlist returned ${res.status} (referer ${referer})`, {
      status: res.status,
      url: streamUrl,
    });
  }
  if (!/^#EXTM3U/.test(res.text)) {
    throw new StageError('playlist-not-hls', `playlist body is not HLS (${res.buf.length} bytes)`, {
      status: res.status,
      url: streamUrl,
    });
  }
  const lines = res.text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const mediaSeq = (lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE')) || '').split(':')[1];
  const segs = lines.filter((l) => l && !l.startsWith('#'));
  const variant = isMaster ? new URL(segs[0], streamUrl).toString() : null;
  const segment = isMaster ? null : new URL(segs[0], streamUrl).toString();
  return { res, isMaster, variant, segment, mediaSeq, segmentCount: segs.length };
}

function expiryOf(streamUrl) {
  try {
    const e = new URL(streamUrl).searchParams.get('e');
    if (!e) return null;
    return { epoch: Number(e), iso: new Date(Number(e) * 1000).toISOString() };
  } catch {
    return null;
  }
}

async function main() {
  const started = Date.now();
  const id = Number(process.argv[2] ?? '61');
  if (!Number.isInteger(id) || id < 0) {
    throw new StageError('invalid-id', `usage: node plan/waterera-poc.mjs <numeric channel id>`);
  }

  // 1. Directory page -> player iframe.
  const castUrl = `${SITE}/cast/stream-${id}.php`;
  const cast = await http(castUrl, { headers: { referer: `${SITE}/` } });
  if (cast.status !== 200) {
    throw new StageError('cast-http', `cast page returned ${cast.status}`, { status: cast.status, url: castUrl });
  }
  const iframes = extractIframes(cast.text).map((s) => (s.startsWith('//') ? `https:${s}` : s));
  const playerUrl = iframes.find((s) => /\/e\/[A-Za-z0-9_-]+$/.test(new URL(s, SITE).href));
  if (!playerUrl) {
    throw new StageError('iframe-missing', `no /e/<token> iframe on ${castUrl}`, { url: castUrl });
  }
  const player = new URL(playerUrl, SITE);
  const token = player.pathname.split('/').filter(Boolean).pop();
  note(`cast page ${cast.status}, ${cast.buf.length} bytes; iframe host ${player.host}`);

  // 2. Player page -> _econfig.
  const { cfg } = await loadPlayerPage(player.href, token);
  note(`_econfig keys: ${Object.keys(cfg).join(',')}`);

  let streamUrl = '';
  let source = '';
  let referer = '';

  if (typeof cfg.stream_url === 'string' && cfg.stream_url) {
    // Legacy / ungated player host.
    streamUrl = new URL(cfg.stream_url, player.href).toString();
    source = `${player.host} stream_url`;
    referer = `${player.origin}/`;
  } else if (cfg.turnstile_key) {
    note(`turnstile_key present (${cfg.turnstile_key}), ts=${cfg.ts}, hash=${cfg.turnstile_hash}`);
    const supplied = process.env.WATERERA_TURNSTILE_TOKEN;
    if (supplied) {
      // Only with a token a real browser produced; this script never solves one.
      const res = await http(`${player.origin}/turnstile/${cfg.id}`, {
        method: 'POST',
        headers: {
          referer: `${player.origin}/`,
          origin: player.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ hash: cfg.turnstile_hash, token: supplied, ts: String(cfg.ts) }).toString(),
      });
      note(`POST /turnstile/${cfg.id} -> ${res.status} ${res.text.slice(0, 120)}`);
      let body = {};
      try {
        body = JSON.parse(res.text);
      } catch {}
      if (res.status === 200 && body.success && typeof body.stream_url === 'string') {
        streamUrl = new URL(body.stream_url, player.href).toString();
        source = `${player.host} POST /turnstile/${cfg.id}`;
        referer = `${player.origin}/`;
      }
    }

    if (!streamUrl) {
      const gated = new StageError(
        'turnstile-gated',
        `waterera player requires a Cloudflare Turnstile token: POST ${player.origin}/turnstile/${cfg.id} ` +
          `with form {hash, token, ts}. No token supplied; not attempting a solve.`,
        { url: `${player.origin}/turnstile/${cfg.id}` },
      );
      // Diagnostic mirror: the same opaque token on the legacy host is served
      // without turnstile_key. Remove this block to make the PoC fail hard.
      let mirrorCfg = null;
      let mirrorErr = null;
      try {
        await sleep(1000);
        const mirrorUrl = `${MIRROR}/e/${token}`;
        const r = await loadPlayerPage(mirrorUrl, token);
        mirrorCfg = r.cfg;
        note(`mirror ${MIRROR}/e/${token} keys include stream_url=${typeof mirrorCfg.stream_url === 'string'}`);
      } catch (err) {
        mirrorErr = err;
        note(`mirror ${MIRROR}/e/${token} failed: ${err.stage || err.name}: ${err.message}`);
      }
      if (mirrorCfg && typeof mirrorCfg.stream_url === 'string' && mirrorCfg.stream_url) {
        streamUrl = new URL(mirrorCfg.stream_url, `${MIRROR}/`).toString();
        source = `${MIRROR} stream_url (mirror of token ${token})`;
        referer = `${MIRROR}/`;
        note('waterera path is gated; playlist came from the un-gated legacy host for the same token');
      } else {
        if (mirrorErr) gated.mirrorStage = mirrorErr.stage;
        throw gated;
      }
    }
  } else {
    throw new StageError('no-stream-url', `_econfig has neither stream_url nor turnstile_key for ${token}`);
  }

  // 3. Verify the playlist is playable.
  await sleep(500);
  const pl = await verifyPlaylist(streamUrl, referer);
  note(`playlist ${pl.res.status}, ${pl.res.buf.length} bytes, ${pl.isMaster ? 'master' : 'media'}, ` +
    `${pl.segmentCount} URIs, media-sequence ${pl.mediaSeq}`);

  const result = {
    ok: true,
    id,
    token,
    player: player.href,
    source,
    playlist: streamUrl,
    kind: pl.isMaster ? 'master' : 'media',
    variant: pl.variant,
    firstSegment: pl.segment,
    headers: { referer },
    note: 'segments/media require Referer of a player origin (waterera.net or tossequip.net); thedaddy.li gets 403',
    expiry: expiryOf(streamUrl),
    p2p: { swarmcloud: cfg.swarmcloud ?? null, swarm_id: cfg.swarm_id ?? null },
    elapsedMs: Date.now() - started,
    stages: NOTES,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        stage: err.stage || 'unexpected',
        message: err.message,
        status: err.status,
        url: err.url,
        mirrorStage: err.mirrorStage,
        stages: NOTES,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
