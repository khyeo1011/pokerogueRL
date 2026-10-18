#!/usr/bin/env bash
# Replay every run in RECORDS (a batch's runs.jsonl) that has recorded actions, i.e. the truncated runs:
# same seed, level and actions, in one batch runner process. Writes their new records to OUT.
# Usage: scripts/replay_runs.sh RECORDS [OUT]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECORDS="$(realpath "$1")"
OUT="$(realpath -m "${2:-${RECORDS%.jsonl}-replay.jsonl}")"

# corepack picks the pnpm version from the cwd's package.json, so run it from inside pokerogue.
cd "$ROOT/pokerogue"
BATCH_REPLAY="$RECORDS" BATCH_OUT="$OUT" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm exec vitest run \
  --configLoader native --config "$ROOT/bridge/batch/vitest.config.ts" --silent
echo "replays: $OUT"
