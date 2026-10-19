# Greedy baseline: average and best wave

2026-10-19, for issue #15. pokerogue v1.12.1.1 (`bdfbef6`), `greedyPolicy` as merged in #57 (`3072134`),
Node 24.19.0, Ryzen 9 9950X3D.

**Result:** over the 10,000 random teams `eval-0 .. eval-9999`, the greedy bot's mean wave is
**25.05** (95% CI 24.73–25.37), and its best is **wave 115** (`eval-6202`). The median is 22. Every run
ended in game over: no truncations, no lost runs. This is the bar the trained agent has to beat.

## Setup

- Seeds `eval-0 .. eval-9999`, the evaluation prefix from `notes/2026-10-17-random-team.md`. Training
  must never use them. They are new to the greedy bot too: #57 was tuned on `cmp-0 .. cmp-999`.
- Team: `randomTeam(seed)`, so a seed fixes the team. Real levels, mystery encounters on (default rate),
  `startClassicRun()` with the game's RNG and `Math.random` seeded from the seed. Default stall limits.
- `wave` is the wave the run lost on (`currentBattle.waveIndex` at game over).

```bash
systemd-run --user --unit=baseline15 --collect -p MemoryMax=40G -p MemorySwapMax=0 -p OOMPolicy=continue \
  -E PATH="$PATH" -E HOME="$HOME" -E NODE_OPTIONS=--max-old-space-size=1024 --working-directory="$PWD" \
  bash -c 'scripts/run_games.sh 10000 24 --policy greedy --prefix eval --chunk 50 --out runs/baseline-greedy'
```

It took 484 s (24 processes, ~74,000 games/h in all, ~31 GB of memory). The wave of every seed is in
`notes/2026-10-19-greedy-baseline/waves.csv`, and the batch summary in `summary.json` next to it.

Runs are deterministic per seed and policy: replaying `eval-6100 .. eval-6299` gave the same wave for all
200, `eval-6202` included.

## Results

| Seeds | Runs | Mean wave (95% CI) | SD | Median | p10 | p90 | Best |
|---|---|---|---|---|---|---|---|
| `eval-0 .. eval-9999` | 10,000 | **25.05** (24.73–25.37) | 16.26 | 22 | 8 | 50 | **115** |
| `eval-0 .. eval-999` | 1,000 | 25.82 (24.81–26.82) | 16.19 | 23 | 8 | 50 | 90 |
| `cmp-0 .. cmp-999` (#57, for reference) | 1,000 | 23.85 (22.87–24.82) | 15.67 | 20 | 8 | 50 | 106 |

The best run, `eval-6202` (Chingling, Dialga), lost on wave 115 to the first evil team boss. 9 runs lost
on wave 100 or later, and none won.

Runs still end mostly on Classic's fixed fights: the rivals on waves 8, 25 and 55, and the bosses every
10th wave.

| Lost on wave | Runs |
|---|---|
| 1–7 | 320 |
| 8 (rival) | 1,403 |
| 9–19 | 2,334 |
| 20 | 880 |
| 21–24 | 568 |
| 25 (rival) | 1,351 |
| 26–49 | 1,765 |
| 50 | 522 |
| 51–99 | 848 |
| 100–115 | 9 |

Runs past wave 10: 7,513; past 20: 5,063; past 30: 2,412; past 50: 857; past 100: 8.

## Comparing a trained agent

Play the agent on the same seeds and settings, and compare per seed against `waves.csv`: the paired
difference removes most of the team-to-team spread (SD 16). Over all 10,000 seeds, the CI on the
greedy mean is ±0.32 waves. `eval-0 .. eval-999` is a cheaper check (±1.0), but its mean (25.82) is not
the official baseline; compare it only against that subset's own row.
