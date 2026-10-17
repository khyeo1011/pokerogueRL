#!/usr/bin/env bash
# Run the bridge's vitest tests (bridge/test/) on pokerogue's test harness. Extra args go to vitest.
# Usage: scripts/test_bridge.sh [VITEST_ARGS...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# corepack picks the pnpm version from the cwd's package.json, so run it from inside pokerogue.
cd "$ROOT/pokerogue"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm exec vitest run \
  --configLoader native --config "$ROOT/bridge/vitest.config.ts" "$@"
