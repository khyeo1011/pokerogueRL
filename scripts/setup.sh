#!/usr/bin/env bash
# Install everything: PokéRogue's Node deps (for the bridge) and this project's Python deps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# pokerogue/ and its own assets/locales submodules.
git -C "$ROOT" submodule update --init --recursive --depth 1
# corepack picks the pnpm version from the cwd's package.json, so run it from inside pokerogue.
(cd "$ROOT/pokerogue" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile)
uv sync --project "$ROOT"
