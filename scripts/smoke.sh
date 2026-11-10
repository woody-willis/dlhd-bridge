#!/bin/sh
# End-to-end smoke test for dlhd-bridge.
#
#   ./scripts/smoke.sh
#   BASE_URL=http://192.168.1.10:8080 ./scripts/smoke.sh
#
# Requires only curl + POSIX shell utilities (no jq). Exit code 0 means every
# check passed. Playback checks resolve one real channel and pull 1 KiB of a
# segment, so the upstream provider must be reachable.
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
BASE_URL="${BASE_URL%/}"
TIMEOUT="${SMOKE_TIMEOUT:-60}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dlhd-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }

# http_get URL OUTFILE -> prints the HTTP status (000 on transport failure)
http_get() {
  code=$(curl -sS -m "$TIMEOUT" -o "$2" -w '%{http_code}' "$1" 2>"$WORK/curl.err") || code="000"
  printf '%s' "$code"
}

curl_hint() {
  if [ -s "$WORK/curl.err" ]; then info "curl: $(sed -n '1p' "$WORK/curl.err")"; fi
}

printf 'dlhd-bridge smoke test against %s\n\n' "$BASE_URL"

# ---------------------------------------------------------------- 1. healthz
code=$(http_get "$BASE_URL/healthz" "$WORK/healthz.json")
if [ "$code" = "200" ] && grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$WORK/healthz.json"; then
  ch=$(sed -n 's/.*"channels":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$WORK/healthz.json")
  ev=$(sed -n 's/.*"events":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$WORK/healthz.json")
  pass "/healthz 200 ok:true (channels=${ch:-?}, events=${ev:-?})"
else
  fail "/healthz expected 200 with \"ok\":true, got ${code}"
  curl_hint
fi

# --------------------------------------------------------------- 2. playlist
code=$(http_get "$BASE_URL/playlist.m3u" "$WORK/playlist.m3u")
if [ "$code" = "200" ] && grep -q '^#EXTM3U' "$WORK/playlist.m3u"; then
  entries=$(grep -c '^#EXTINF' "$WORK/playlist.m3u" || true)
  if [ "$entries" -ge 100 ]; then
    pass "/playlist.m3u 200, starts #EXTM3U, ${entries} entries (>=100)"
  else
    fail "/playlist.m3u has only ${entries} #EXTINF lines (expected >=100)"
  fi
else
  fail "/playlist.m3u expected 200 + '#EXTM3U', got ${code}"
  if [ -s "$WORK/playlist.m3u" ]; then info "body: $(sed -n '1p' "$WORK/playlist.m3u")"; fi
  curl_hint
fi

# ------------------------------------------------------------------ 3. xmltv
code=$(http_get "$BASE_URL/xmltv.xml" "$WORK/xmltv.xml")
if [ "$code" = "200" ] && grep -q '^<?xml' "$WORK/xmltv.xml" \
  && grep -q '<tv' "$WORK/xmltv.xml" && grep -q '<programme' "$WORK/xmltv.xml"; then
  channels=$(grep -c '<channel ' "$WORK/xmltv.xml" || true)
  programmes=$(grep -c '<programme ' "$WORK/xmltv.xml" || true)
  pass "/xmltv.xml 200, XMLTV with ${channels} channels, ${programmes} programmes"
else
  fail "/xmltv.xml expected 200 + <?xml + <tv + <programme, got ${code}"
  curl_hint
fi

# ------------------------------------------------------- 4. stream playlist
stream_path=$(grep -o '/stream/[0-9][0-9]*\.m3u8' "$WORK/playlist.m3u" 2>/dev/null | head -n 1 || true)
if [ -n "${stream_path:-}" ]; then
  code=$(http_get "$BASE_URL$stream_path" "$WORK/stream.m3u8")
  if [ "$code" = "200" ] && grep -q '^#EXTM3U' "$WORK/stream.m3u8" \
    && grep -q '/seg/' "$WORK/stream.m3u8"; then
    pass "$stream_path 200, rewritten playlist with /seg/ links"
  else
    fail "$stream_path expected 200 + '#EXTM3U' + '/seg/', got ${code}"
    curl_hint
  fi
else
  code="000"
  fail "no /stream/<id>.m3u8 URL found in /playlist.m3u"
fi

# ----------------------------------------------------------- 5. segment range
seg_path=$(grep -o '/seg/[A-Za-z0-9_/-]*' "$WORK/stream.m3u8" 2>/dev/null | head -n 1 || true)
if [ -n "${seg_path:-}" ]; then
  code=$(curl -sS -m "$TIMEOUT" -H 'Range: bytes=0-1023' -o "$WORK/seg.bin" \
    -w '%{http_code}' "$BASE_URL$seg_path" 2>"$WORK/curl.err") || code="000"
  bytes=$(wc -c < "$WORK/seg.bin" | tr -d ' ')
  case "$code" in
    200|206)
      if [ "$bytes" -gt 0 ]; then
        pass "segment Range 0-1023 -> HTTP ${code}, ${bytes} bytes"
      else
        fail "segment returned ${code} but an empty body"
      fi
      ;;
    *)
      fail "segment Range request expected 200/206, got ${code}"
      curl_hint
      ;;
  esac
else
  fail "no /seg/ URL found in ${stream_path:-the stream playlist}"
fi

# ---------------------------------------------------------------- 6. summary
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
