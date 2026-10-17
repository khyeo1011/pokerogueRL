#!/usr/bin/env bash
# Play RUNS runs of the real game (random teams, default policy, mystery encounters on) in PROCESSES
# parallel processes, then merge and summarize them under runs/games-<timestamp>/.
# Usage: scripts/run_games.sh RUNS [PROCESSES] [--prefix P] [--start N] [--out DIR]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec uv run python -m pokerogue_rl.games "$@"
