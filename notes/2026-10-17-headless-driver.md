# Headless driver: findings

2026-10-17, for issue #2. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux.

**Result:** `bridge/driver.ts` steps the phase queue itself and runs a Classic game about **36× faster**
than the harness's `PhaseInterceptor`: ~304 turns/s against 8.3 turns/s for the same 75-turn run.
`bridge/test/driver.test.ts` plays the smoke test's policy (`classic-run.test.ts`) through the driver.

## Where the time went

`PhaseInterceptor.run` starts a phase, then checks every 50 ms whether it has ended
(`vi.waitUntil(..., { interval: 50 })` in `test/framework/phase-interceptor.ts`). Phases that end
synchronously cost nothing, since `waitUntil` checks once before it starts polling. Any phase that ends
from a timer or a promise (messages, UI mode transitions, anything using `scene.time`) costs up to 50 ms.
Most of a run is in those phases.

## How the driver works

- **Phase ends:** the driver replaces `phaseManager.startCurrentPhase` (which `shiftPhase` calls when a
  phase ends) with a hook that records the end and wakes `next()`. The driver then starts the next phase
  itself. The interceptor patches the same function the same way. The difference is that the driver waits
  on a promise, not a timer.
- **Decisions:** the driver wraps `ui.setModeInternal`. Once a mode transition finishes, if the
  (mode, phase) pair waits for input, it raises a decision and keeps the callback from the mode's `args`.
  `act()` calls that callback, or `CommandPhase.handleCommand`, directly. No UI handler input is simulated.

| Decision | Raised on | Answered by |
|---|---|---|
| `command` | `COMMAND`/`FIGHT` in `CommandPhase` | `handleCommand(Command.FIGHT, slot)` |
| `target` | `TARGET_SELECT` in `SelectTargetPhase` | the mode's callback with `[target]` |
| `switch` | `PARTY` in `SwitchPhase` | the mode's callback with `(slot, SEND_OUT)` |
| `reward` | `MODIFIER_SELECT` in `SelectModifierPhase` | callback `(-1, -1)`, then the skip `CONFIRM` is answered yes |
| `gameOver` | `GameOverPhase` is next | (not started, so the game never reaches the title screen) |

Issue #7 extended this to every decision point: see `2026-10-17-decision-points.md` for the full table.

Boot still goes through the harness (`classicMode.runToSummon`, ~0.5 s). It stops after `EncounterPhase`
ends, so the driver takes over with no phase running.

## Benchmark

Three runs each of `scripts/test_bridge.sh classic-run` and `scripts/test_bridge.sh driver`. Same starters
and policy. The game took one of two paths:

| Path | Interceptor | Driver |
|---|---|---|
| A: game over on wave 7, 75 turns | 9.0 s, 8.3 turns/s (1 run) | 0.25 s, 303–306 turns/s (3 runs) |
| B: double battle on wave 7, game over on wave 8, 21 turns | 5.6 s, 3.7 turns/s (2 runs) | not seen |

Path A per turn: the interceptor takes ~120 ms, the driver ~3.3 ms (~23 phases per turn).

## Observations

- **Reproducibility may be a timing issue, not RNG.** The 2026-10-16 note saw the same seed end on
  different waves. The driver was identical across its 3 runs (75 turns, 89 decisions, 1727 phases), while
  the interceptor split 1/2 between the two paths. A likely cause: the interceptor's polling interleaves
  with `MockClock`'s 1 ms `setInterval` at varying points. Not proven: 3 runs, and #3 replaces the RNG anyway.
- **No stall handling.** If a phase waits on something the driver doesn't recognise (learn-move prompt,
  evolution, mystery encounter, check-switch), `next()` waits forever. Covering every decision point is #7;
  watchdogs are #9.
- The harness's game changes (max damage rolls, no mystery encounters, normalized IVs/natures) are still
  active. Undoing them is #3.
