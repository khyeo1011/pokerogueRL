# Stall detection and batch runs: findings

2026-10-17, for issue #9. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux, 32 cores.

**Result:** the driver now ends a run that can't finish with a `truncated` decision, which carries a
stall report and is logged as one JSON line. Game over stays `gameOver` (terminated). `scripts/run_games.sh`
plays random-team runs of the real game in parallel processes. The first batches got stuck. That was not
the game: the harness leaked into every later run in the same process. Fixing that (plus one decision
loop and the double-flee crash) brought 2,000 runs to finish in 116 s on 16 processes: 1,999 ended in
game over and 1 was truncated by an upstream crash.

## Outcome API

`Driver.next()` returns `{ kind: "truncated", reason, stall, legal: [] }`. Every later `next()` returns
the same decision; `act()` and `observe()` throw. `stall` (`StallReport`) is plain JSON: `reason`,
`detail`, `seed`, `wave`, `biome`, `phase`, `uiMode`, `lastDecision`, `turns`, `waveTurns`, `phases`,
`decisions`, `gameMs`, `error` (stack, for crashes). The driver also logs it with `console.warn` as
`{"event":"truncated", ...}`.

| Reason | Trips when | Default |
|---|---|---|
| `noProgress` | phases + decisions with no turn end and no new wave | 5,000 |
| `phaseTimeout` | one phase runs this long (wall clock; checked between phases and every 250 ms while awaiting) | 15 s |
| `runTimeout` | game time inside `next()` over the run (policy time not counted) | 300 s |
| `waveTurnCap` | turns in one wave | 300 |
| `runTurnCap` | turns in the run | 10,000 |
| `noLegalAction` | a decision with no legal action (#8 threw here before) | |
| `crash` | game code threw: in a phase, in an answer (`act()`), in a UI hook, or as an unhandled rejection or uncaught exception while `next()` runs | |

Limits are per driver: `new Driver(game, { waveTurnCap: 50 })`. The defaults sit far above anything a
finished run needed. Over 2,000 default-policy runs at real levels and 320 at level 100 (below):

- the longest wave was 86 turns (the two longest were both in teams with Wynaut);
- the longest run was 304 turns;
- one `next()` call ran at most 79 phases.

A stalemate costs about a second of game time before the wave cap ends it.

One thing no watchdog in the process can catch is game code that loops without returning: the
event loop never comes back to the driver. The batch runner handles that from outside (below).

## What the batches found

| Problem | Seen as | Fix |
|---|---|---|
| A process slowed down with every run | 3 of 16 processes stuck at 100% CPU after ~100 runs each. Run time grew from 0.3 s to 9 s per run, then a run took minutes | `restoreRealGame()` (bridge/run.ts), see below |
| Memory Mushroom on an unimplemented move | `big-1547`: 29,057 decisions on wave 7, ended only by `runTimeout` after 300 s | Remembered moves that are unimplemented ("Bide (N)") are no longer legal targets. Picking one ends `LearnMovePhase` without teaching anything, and the reward screen comes back unchanged, so the default policy picked it forever. `noProgress` now counts decisions too, so a loop like this ends after 5,000 steps |
| `CommonBattleAnim.play` crash after fleeing a double battle (#8's `me-run-random-legendary-18`) | `TypeError ... 'setPosition'` | Root cause is the harness, see below. The run now plays on to game over |
| `PostSummonPhasePriorityQueue` crash (`big-1951`) | `TypeError ... 'getAbilityPriorities'`, wave 7 | Upstream, not fixed: truncated as `crash`. Both player Pokémon of a double battle faint along with the last enemy. `FaintPhase` pushes a `SwitchPhase` for field slot 1, and it runs in the next battle, a single one, where slot 1 has no battler |

### The harness leaks into later runs

The harness reuses one `BattleScene` for every `GameManager` (`resetScene()`), so whatever a run leaves
reachable from the scene stays. A heap snapshot after run 4 and after run 20 showed three causes:

- **Mock containers keep destroyed children.** The field and field UI are `MockContainer`s, and their
  `add()` doesn't listen for the child's destroy event as Phaser's `Container` does. Destroyed Pokémon and
  their battle infos stayed in the field (409 `EnemyPokemon` over 16 runs). The same gap caused the
  double-flee crash: a destroyed enemy stays on the field with no sprite, `isOnField()` is still true, and a
  trap's damage animation at turn end aims at it.
- **Mock sprites pile up.** `MockTextureManager.list` keeps every mock object ever created and nothing
  reads it. The Tera sparkle handler only forgets destroyed sprites on a tween repeat, which the mock
  tweens never fire.
- **Sprite listeners on the global animation manager.** Each mock sprite wraps a real Phaser sprite,
  whose `AnimationState` listens on `game.anims` until destroyed. The UI drops many without destroying
  them: about 1,100 more listeners per run. Each destroyed sprite searches that listener array, so
  destroying got slower with every run. This was the slowdown. The CPU profile of a late run was
  dominated by `removeListener` under `Sprite.preDestroy`.

`restoreRealGame()` (called by `startClassicRun`) now patches `MockContainer.add`/`addAt` to drop
destroyed children. At each run's start it also empties the mock list and the sparkle set, and removes
the animation manager's `remove` listeners, which only matter when an animation is removed from the
manager, and that never happens. The heap still grows (≤750 MB after 100 runs in a process), so the batch
runner starts a new process every 100 runs. `Driver.dispose()` now also takes the driver's hooks off the
scene, so old drivers aren't kept alive through it.

## Reproducibility

`startClassicRun()` now replaces `Math.random` (until the test ends, through vitest's `restoreMocks`)
with a generator seeded from the run's seed. Upstream's `getRandomTrainerFunc()` picks the evil-team
trainers on waves 35, 62, 64 and 66 with `Math.random`. Before this, 3 of 12 level-100 runs ended
differently on a second try. With it, the same 12 runs matched across processes. `run.test.ts` also
plays one level-100 seed twice in one process, past wave 35, and finds the same decision trace and party.
The number of phases can still differ by one between replays: some phases are queued from timers.

## Batch runner

```bash
scripts/run_games.sh 160 4        # 160 runs, 4 processes, seeds batch-0 .. batch-159
scripts/run_games.sh 2000 16 --prefix train --chunk 100 --stall-seconds 420 --out runs/x
```

- **Shape.** `src/pokerogue_rl/games.py` cuts the seeds into chunks of at most 100 runs. It runs up to N
  vitest processes at once on `bridge/batch/games.batch.ts` (its own config, outside the normal test run),
  one `it` per run, so the harness resets the game between runs.
- **Each run.** `randomTeam(seed)`, `startClassicRun()` (real RNG, mystery encounters on), the default
  policy, Set battle style (the harness's).
- **Output.** One JSON line per run: `seed`, `team`, `outcome` (`victory`, `terminated`, `truncated`, or
  `error`/`lost` from the runner), `reason`, `wave`, `turns`, `maxWaveTurns`, `decisions`, `phases`,
  `maxPhasesPerNext`, `mysteryEncounters`, `bootMs`, `wallMs`, `heapMb`, `stall`.
- **Stuck processes.** A process that writes nothing for `--stall-seconds` is killed. Its current run is
  recorded as `lost`, and the rest of its chunk goes on in a new process.
- **Results.** `runs/games-<timestamp>/runs.jsonl` and `summary.json`: outcomes, truncation reasons and
  where they happened, waves, turns, decisions, wall and boot time, mystery encounters by type.

## Run results

Default policy, random teams (`randomTeam`), real game, mystery encounters on. The level-100 batch set
`startingLevel(100)` through a local change to the runner that isn't committed.

| Batch | Runs | Outcomes | Wave (min / median / max) | Turns (median / max) | Wall per run (median / mean / p95) | Elapsed |
|---|---|---|---|---|---|---|
| 160 (40 × 4 processes) | 160 | 160 game over | 3 / 9 / 49 | 33 / 105 | 268 / 352 / 836 ms | 25 s |
| 2,000 × 16 processes | 2,000 | 1,999 game over, 1 truncated (`crash`, upstream) | 1 / 9 / 64 | 32 / 138 | 301 / 412 / 976 ms | 116 s |
| Level 100, 320 × 16 processes | 320 | 320 game over | 13 / 90 / 115 | 155 / 304 | 2.3 / 2.3 / 3.4 s | 62 s |

Boot is ~105 ms per run (~550 ms for a process's first), plus ~6 s of vitest startup per process.

Waves reached in the 2,000 runs: 1–7: 279, 8: 586 (the rival), 9–10: 343, 11–20: 458, 21–35: 245,
36–60: 88, 61+: 1. 378 runs met at least one mystery encounter (517 in all). At level 100, every run met
some (1,586 in all).
