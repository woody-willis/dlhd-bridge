#!/bin/sh
# Development entrypoint: restart on source changes with debug logging.
set -eu

cd "$(dirname "$0")/.."
exec env LOG_LEVEL=debug node --watch src/index.js
