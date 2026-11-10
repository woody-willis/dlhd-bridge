#!/bin/sh
# Install the DLHD -> Jellyfin bridge on a Debian/Ubuntu host (LXC or VM)
# directly from git.
#
#   sudo sh deploy/install.sh
#   sudo REPO=https://github.com/you/dlhd-bridge.git sh deploy/install.sh
#
# Installs a standalone Node 22 runtime, clones the repository to
# /opt/dlhd-bridge, installs dlhd-bridge.service and starts it on
# 127.0.0.1:8080. Idempotent: re-running updates the checkout and restarts.
set -eu

REPO="${REPO:-https://github.com/woody-willis/dlhd-bridge.git}"
BRANCH="${BRANCH:-main}"
NODE_VERSION="${NODE_VERSION:-22.20.0}"
APP_DIR="${APP_DIR:-/opt/dlhd-bridge}"
NODE_DIR="${NODE_DIR:-/opt/node22}"
UNIT_PATH="/etc/systemd/system/dlhd-bridge.service"
UPDATE_BIN="/usr/local/sbin/dlhd-bridge-update"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v git >/dev/null 2>&1; then
  echo "==> installing git"
  apt-get update -qq
  apt-get install -y -qq git ca-certificates
fi

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "==> installing Node $NODE_VERSION ($NODE_ARCH) into $NODE_DIR"
  tmp="$(mktemp -d)"
  tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" -o "$tmp/$tarball"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  ( cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c - )
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
"$NODE_DIR/bin/node" --version

if [ -d "$APP_DIR/.git" ]; then
  echo "==> updating checkout in $APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  echo "==> cloning $REPO into $APP_DIR"
  rm -rf "$APP_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"
echo "    at $(git -C "$APP_DIR" rev-parse --short HEAD) ($(git -C "$APP_DIR" log -1 --format=%s))"

echo "==> installing systemd unit"
install -m 0644 "$SRC_DIR/deploy/dlhd-bridge.service" "$UNIT_PATH"

# The updater lives outside the checkout so it survives `git reset --hard`.
install -m 0755 "$SRC_DIR/deploy/update.sh" "$UPDATE_BIN"

systemctl daemon-reload
systemctl enable dlhd-bridge.service
systemctl restart dlhd-bridge.service

echo "==> waiting for the first catalogue scrape"
i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/healthz >/tmp/dlhd-healthz.json 2>/dev/null; then
    cat /tmp/dlhd-healthz.json
    echo
    break
  fi
  i=$((i + 1))
  sleep 2
done

curl -fsS --max-time 25 http://127.0.0.1:8080/playlist.m3u | grep -c '^#EXTINF' | sed 's/^/playlist entries: /'
echo "done. Jellyfin tuner:  http://127.0.0.1:8080/playlist.m3u"
echo "      Jellyfin guide:  http://127.0.0.1:8080/xmltv.xml"
echo "      update later:    sudo $UPDATE_BIN"
