#!/usr/bin/env bash
# Start N headless bridge processes on BASE_PORT .. BASE_PORT+N-1. Ctrl-C stops all.
# Usage: scripts/start_server.sh [NUM_ENVS]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NUM_ENVS="${1:-4}"
BASE_PORT="${BASE_PORT:-7700}"

trap 'kill $(jobs -p) 2>/dev/null' EXIT
for ((i = 0; i < NUM_ENVS; i++)); do
  node "$ROOT/bridge/server.ts" --port "$((BASE_PORT + i))" &
done
wait
