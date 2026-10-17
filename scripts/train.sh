#!/usr/bin/env bash
# Train against bridges started by scripts/start_server.sh (same NUM_ENVS / BASE_PORT).
# Usage: scripts/train.sh [NUM_ENVS] [extra pokerogue-train args...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NUM_ENVS="${1:-4}"
BASE_PORT="${BASE_PORT:-7700}"

cd "$ROOT"
exec uv run pokerogue-train --num-envs "$NUM_ENVS" --base-port "$BASE_PORT" "${@:2}"
