# Throughput: games per hour and env steps per second

2026-10-17, for issue #11. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19.0, Linux (Fedora, kernel 7.2),
AMD Ryzen 9 9950X3D (16 cores, 32 threads), 60 GB RAM, otherwise idle.

**Result:** one worker (one bridge process) plays about **170 env steps per second** (decisions, boot
included) and **7,000–7,700 games per hour** on real-level random-team runs, which are short (median
wave 9, 38 turns, 83 decisions). Per-worker speed holds up to 16 processes (−7 % at 16) and drops 20 %
at 32, where SMT siblings share cores. At **8 workers that is about 1,340 env steps/s, ~4.8 M env steps
per hour**, before any Python, TCP or policy cost. Long runs (starters at level 100, median wave 90, 400
decisions) run at the same speed per step in a fresh process, ~185 steps/s and ~1,700 games/h, but
**each process slows down as it plays more waves**: after ~5,000 waves it runs at half speed (below).

## How it was measured

Default policy, random teams, real game, mystery encounters on, through the batch runner. Each config
gives every process the same number of runs (one chunk), seeds `tp-0 ..` (real levels) and `tp100-0 ..`
(level 100), so a bigger config replays the smaller one's seeds and more.

```bash
scripts/run_games.sh 500 1 --prefix tp --out runs/throughput/real-p1     # 5 chunks of 100, one after another
scripts/run_games.sh 400 4 --prefix tp --out runs/throughput/real-p4     # 100 runs per process
scripts/run_games.sh 800 8 --prefix tp --out runs/throughput/real-p8
scripts/run_games.sh 1600 16 --prefix tp --out runs/throughput/real-p16
scripts/run_games.sh 3200 32 --prefix tp --out runs/throughput/real-p32
scripts/run_games.sh 100 1 --prefix tp100 --level 100 --out runs/throughput/l100-p1   # 100 runs in one process
scripts/run_games.sh 200 4 --prefix tp100 --level 100 --out runs/throughput/l100-p4   # 50 per process
scripts/run_games.sh 400 8 --prefix tp100 --level 100 --out runs/throughput/l100-p8
scripts/run_games.sh 800 16 --prefix tp100 --level 100 --out runs/throughput/l100-p16
scripts/run_games.sh 100 1 --prefix tp100 --level 100 --chunk 20 --out runs/throughput/l100c20-p1
scripts/run_games.sh 400 8 --prefix tp100 --level 100 --chunk 20 --out runs/throughput/l100c20-p8
```

`--level L` (new) sets the starters' level through the harness's `startingLevel` override, as #9 did
by hand. `summary.json` now has a `perWorker` block (from the run records), and `aggregate`,
`processStartupS` and `betweenRunsMs` (from the batch):

- **Per worker:** totals over the time a process spends booting and playing runs. Games/h is
  3600 × runs / (boot + play seconds); turns/s and env steps/s (`decisionsPerSecond`) are totals over the
  same time. `playDecisionsPerSecond` leaves boot out. A worker's time includes the default policy and
  building the observation at every decision (`driver.observe()`), as an env step would.
- **Aggregate:** totals over the batch's elapsed time, process startup and the last stragglers included.
  Short batches undersell steady state; per worker × processes is the steady-state figure.
- An **env step** is one decision (`Driver.decisions`): what MaskablePPO will step on. A turn is ~2.2
  decisions at real levels (command, target, rewards, ...), 2.4 at level 100.

## Real levels (short runs)

| Processes | Runs | Per worker: games/h | turns/s | env steps/s | steps/s, play only | Aggregate: games/h | env steps/s | Elapsed |
|---|---|---|---|---|---|---|---|---|
| 1 | 500 | 7,664 | 80.7 | 175.7 | 228.1 | 6,922 | 159 | 260 s |
| 4 | 400 | 7,694 | 81.7 | 177.8 | 231.3 | 26,176 | 605 | 55 s |
| 8 | 800 | 7,190 | 76.8 | 167.8 | 214.4 | 48,804 | 1,139 | 59 s |
| 16 | 1,600 | 7,002 | 74.4 | 163.8 | 208.3 | 84,679 | 1,981 | 68 s |
| 32 | 3,200 | 6,021 | 64.1 | 141.7 | 175.6 | 140,419 | 3,304 | 82 s |

Runs: median wave 9, mean 38 turns, 83 decisions; median 0.27 s of play (0.35 s at 32 processes).
Boot is a quarter of a worker's time on these runs: 104 ms per run against ~370 ms of play.

## Level 100 (long runs)

| Config | Runs per process | Per worker: games/h | turns/s | env steps/s | steps/s, play only | Aggregate: env steps/s |
|---|---|---|---|---|---|---|
| 1 process | 100 | 1,017 | 45.5 | 109.2 | 112.7 | 108 |
| 4 processes | 50 | 1,267 | 57.2 | 139.3 | 145.2 | 527 |
| 8 processes | 50 | 1,162 | 52.8 | 129.5 | 134.6 | 938 |
| 16 processes | 50 | 1,138 | 50.9 | 125.1 | 130.0 | 1,778 |
| 1 process, `--chunk 20` | 20 | 1,730 | 77.4 | 185.7 | 197.8 | 165 |
| 8 processes, `--chunk 20` | 20 | 1,528 | 69.3 | 170.2 | 180.2 | 1,009 |

Runs: median wave 90–93, mean 162 turns, 395 decisions. With fresh processes (chunks of 20) a level-100
worker is as fast per step as a real-level one, and boot hardly counts (~5 %). With 50–100 runs per
process it is 25–40 % slower: the slowdown below. (The 8-process `--chunk 20` aggregate is held down by
uneven chunks: 20 chunks over 8 processes.)

## A process slows down with the waves it has played

Within one process, speed falls with the number of waves played so far, and the heap grows. Level 100,
one process, 100 runs (`l100-p1`), env steps per second of play by block of 20 runs:

| Runs | Waves played before | Steps/s (play) | Heap after (MB) |
|---|---|---|---|
| 0–19 | 0 | 198 | 498 |
| 20–39 | 1,763 | 148 | 719 |
| 40–59 | 3,406 | 114 | 824 |
| 60–79 | 5,164 | 93 | 1,073 |
| 80–99 | 6,947 | 78 | 1,230 |

At real levels a chunk of 100 runs is only ~1,360 waves, so the batch runner's chunks hide it (blocks
of 50 runs stay within 218–243 steps/s over 500 runs). #9 fixed the leaks that grew per run; this one grows per wave and isn't
tracked down yet. It matters for training: a long-lived bridge process will play many thousands of waves.
Until it is fixed, the bridge server should restart its game process every ~1,000–2,000 waves (each
restart costs the ~5 s process startup), and the batch runner wants `--chunk 20` for long runs.

## Startup

| Processes | Process startup (launch to first run; median) | First boot in a process | Later boots | Between runs |
|---|---|---|---|---|
| 1 | 4.4 s | 545 ms | 103 ms | 0.5 ms |
| 4 | 4.6 s | 562 ms | 104 ms | 0.5 ms |
| 8 | 5.2 s | 578 ms | 104 ms | 0.5 ms |
| 16 | 7.3 s | 645 ms | 104 ms | 0.6 ms |
| 32 | 14.1 s | 1,078 ms | 106 ms | 0.7 ms |

Process startup is vitest: transforming the game's modules and the harness setup, slower when many
processes start at once. Booting a run (`new GameManager`, title screen, starters, wave 1's encounter) is
~105 ms; the first one in a process takes ~0.55 s more. Vitest adds nothing measurable between runs.

## What this means for PPO

- **8 workers:** ~170 steps/s each, **~1,340 env steps/s, ~4.8 M env steps per hour** of game time.
  16 workers: ~2,600 steps/s, ~9.4 M/h. 32 workers buy only ~1.7× over 16 (SMT).
- So 10 M timesteps take ~2 h at 8 workers, ~1 h at 16, if the policy, the observation encoding and the
  TCP round trip are cheap next to the game's ~6 ms per step. None of that is measured here: the TCP
  server is still a stub, and these numbers are the game plus the driver only.
- An episode reset (boot) is ~105 ms, about 18 steps' worth of time. It is a quarter of the time on
  today's short runs and shrinks as the agent survives longer.
- The per-wave slowdown halves throughput after ~5,000 waves in a process. Fix it or restart processes.

## Outcomes

These batches were all game over except 6 seeds that end as `truncated` every time they are played: 5
`noLegalAction` and 1 `crash`, all caught and logged by the driver, none lost and no process killed. Both
are upstream problems: a player Pokémon that faints along with the last enemy leaves a forced switch
that runs in the next battle, a double one, where the party screen offers no Pokémon to send out
(`noLegalAction`); and an enemy's sprite is gone when its asset load finishes (`crash` in
`EnemyPokemon.playSprite`). More in the Phase 1 acceptance write-up (#12).
