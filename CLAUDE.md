# CLAUDE.md

RL agents for PokéRogue. Setup and usage are in README.md.

## Where things go

- `pokerogue/`: upstream game, a git submodule. Treat it as read-only: no edits, no commits. Game-side code we write goes in `bridge/`.
- `bridge/`: TypeScript, one headless game per process, newline-delimited JSON over TCP. Currently a stub. The real version should reuse `pokerogue/`'s vitest harness (jsdom + `test/setup/*` + `#alias` paths in its `tsconfig.json`).
- `src/pokerogue_rl/`: Python package. `env.py` is the Gymnasium env (bridge client), `train.py` is the training entry point. New modules (observation encoding, policies, eval) go here.
- `scripts/`: shell entry points only (setup, start bridges, train). Keep the logic in Python/TS.
- `tests/`: pytest (`uv run pytest`). CI (`.github/workflows/ci.yml`) runs ruff and pytest with CPU torch, without the submodule.
- `runs/`: training outputs, gitignored.

## Conventions

- Python deps: `uv add <pkg>`. Run with `uv run ...`. Never use pip.
- Node deps for the bridge come from `pokerogue/` (`corepack pnpm`, run from inside `pokerogue/`).
- `OBS_DIM` (and the action count) are defined in both `bridge/server.ts` and `src/pokerogue_rl/env.py`. Change both together.
