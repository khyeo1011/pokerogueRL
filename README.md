# pokerogueRL

Reinforcement learning agents for [PokéRogue](https://github.com/pagefaultgames/pokerogue).

The game runs headlessly in Node, one process per environment (the **bridge**). Python training code talks to each bridge over a local TCP socket via a Gymnasium env.

```
train.py ── SubprocVecEnv ──┬── PokeRogueEnv ──TCP:7700── bridge/server.ts
                            ├── PokeRogueEnv ──TCP:7701── bridge/server.ts
                            └── ...
```

> **Status:** the real game runs headlessly in the bridge's driver (`bridge/driver.ts`): every decision point, mystery encounters, observations, a scripted default policy, and stall detection. `scripts/run_games.sh` plays it in batches. The TCP server (`bridge/server.ts`) is still a stub that serves dummy episodes (action 0 earns reward), so the training pipeline can be tested end to end, but it doesn't serve the real game yet.

## Requirements

- [uv](https://docs.astral.sh/uv/)
- Python 3.14 (uv uses the system interpreter)
- Node ≥ 24.9 with corepack (pnpm 10.34.5 is fetched automatically from `pokerogue/package.json`)
- Optional: an NVIDIA GPU. The default torch wheel is built for CUDA 13.

## Setup

```bash
git clone --recurse-submodules <this repo>   # or: git submodule update --init --recursive
cd pokerogueRL
scripts/setup.sh
```

`setup.sh` initializes the `pokerogue` submodule (and its `assets`/`locales` submodules), runs `pnpm install` inside it, and runs `uv sync`. It is safe to re-run.

## Running

In one terminal, start N bridge processes on ports `7700 .. 7700+N-1`:

```bash
scripts/start_server.sh 8
```

In another terminal, train with the same N:

```bash
scripts/train.sh 8 --timesteps 1000000
```

Runs are saved to `runs/<timestamp>/model.zip`. Set `BASE_PORT` (in both terminals) to use a different port range. `scripts/train.sh N --help` lists all training flags.

## Batch runs

Play many runs of the real game (random starter teams, the scripted default policy, mystery encounters
on) to check that none hangs, here 160 runs in 4 processes:

```bash
scripts/run_games.sh 160 4
```

Each run writes one JSON line (seed, team, outcome, waves, turns, timings, the stall report if the driver
truncated it) to `runs/games-<timestamp>/runs.jsonl`, and a summary goes to `summary.json`. See
`notes/2026-10-17-stall-detection.md`.

Add `--level 100` to start the starters at level 100: runs then last ~90 waves instead of ~9.

Add `--policy random` to play uniformly random legal actions instead, seeded from the run's seed. It
switches, throws balls, runs, buys and rerolls, which the default policy never does, so it reaches game
states (and game bugs) the default policy can't. A truncated run's record also has every action taken, and
`scripts/replay_runs.sh runs/games-<timestamp>/runs.jsonl` replays those runs from their seeds and actions.

## Throughput

One bridge process plays the real game at about 170 env steps (decisions) per second, boot included:
~7,500 games per hour of today's short runs. Speed per process holds up to 16 processes on a 16-core
machine, so 8 processes give ~1,340 env steps/s, ~4.8 M per hour, before policy and TCP costs. A
process slows down as it plays more waves (half speed after ~5,000), so restart long-lived ones. See
`notes/2026-10-17-throughput.md`.

## Layout

| Path | What |
|---|---|
| `pokerogue/` | Upstream game (git submodule, pinned commit). Don't edit it; see `CLAUDE.md`. |
| `bridge/` | TypeScript bridge: runs a headless game and serves it over TCP |
| `bridge/test/` | Vitest tests on pokerogue's harness (`scripts/test_bridge.sh`) |
| `bridge/batch/` | Batch runner: many real-game runs per process (`scripts/run_games.sh`) |
| `src/pokerogue_rl/env.py` | Gymnasium env (client for one bridge) |
| `src/pokerogue_rl/train.py` | Training entry point (`pokerogue-train`) |
| `src/pokerogue_rl/games.py` | Launches batch runs in parallel and summarizes them |
| `scripts/` | `setup.sh`, `start_server.sh`, `train.sh`, `test_bridge.sh`, `run_games.sh`, `replay_runs.sh` |
| `notes/` | Findings and investigation write-ups |
| `runs/` | Training and batch outputs (gitignored) |

## Updating PokéRogue

```bash
git -C pokerogue fetch origin main && git -C pokerogue checkout <commit>
git add pokerogue && git commit -m "Bump pokerogue"
scripts/setup.sh
```
