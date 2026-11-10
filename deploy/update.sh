#!/bin/sh
# Pull the latest dlhd-bridge from git and restart it if anything changed.
#
#   sudo dlhd-bridge-update
#
# Exit codes: 0 = up to date or updated, 1 = update failed (nothing restarted).
set -eu

APP_DIR="${APP_DIR:-/opt/dlhd-bridge}"
BRANCH="${BRANCH:-main}"
UNIT="${UNIT:-dlhd-bridge.service}"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -d "$APP_DIR/.git" ] || { echo "$APP_DIR is not a git checkout" >&2; exit 1; }

before="$(git -C "$APP_DIR" rev-parse HEAD)"

if ! git -C "$APP_DIR" fetch --quiet --depth 1 origin "$BRANCH"; then
  echo "git fetch failed; keeping current version" >&2
  exit 1
fi

if [ "$before" = "$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")" ]; then
  echo "already up to date ($(git -C "$APP_DIR" rev-parse --short HEAD))"
  exit 0
fi

git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"
echo "updated $(echo "$before" | cut -c1-7) -> $(git -C "$APP_DIR" rev-parse --short HEAD): $(git -C "$APP_DIR" log -1 --format=%s)"

systemctl restart "$UNIT"

i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "healthy: $(curl -fsS --max-time 3 http://127.0.0.1:8080/healthz)"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "service did not become healthy; check: journalctl -u $UNIT -n 50" >&2
exit 1
