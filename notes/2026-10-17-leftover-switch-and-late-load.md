# Runs that ended early from game bugs: leftover forced switch, late asset load

2026-10-17, for issue #51. pokerogue v1.12.1.1 (`bdfbef6`).

**Result:** all three upstream bugs that ended runs early are worked around in the bridge. The 11 seeds
from the issue now play to game over (default policy, `randomTeam(seed)`, level 100 for `accept100-*` and
`tp100-*`). Tests on `tp-226`, `big-1951` and `tp100-324` are in `bridge/test/stall.test.ts`.

| Seed | Before | After |
|---|---|---|
| `tp-226`, `tp-643`, `tp-1069` | `noLegalAction` | game over, waves 2, 6, 36 |
| `accept100-57`, `accept100-144`, `accept100-229` | `noLegalAction` | game over, waves 79, 77, 65 |
| `tp100-323`, `tp100-564`, `tp100-630` | `noLegalAction` | game over, waves 94, 90, 66 |
| `big-1951` | `crash` (`getAbilityPriorities`), wave 7 | game over, wave 8 |
| `tp100-324` | `crash` (`reading 'play'`), wave 92 | game over, wave 95 |

## 1 and 2: a forced switch left over from the last battle

A phase trace shows where the leftover switch runs. When the player's Pokémon faints with the last enemy,
`FaintPhase` pushes a modal `SwitchPhase` (`doReturn` false) to the end of the queue. The battle ends first,
so it runs after `NewBattlePhase` and `PartyReorderSwitchPhase`, before the new wave's `EncounterPhase`, with
`currentBattle` already the new battle:

- **Single into double** (`tp-226`): party slot 1 counts as a field slot, so the party screen offers only
  slots 2 and up, and a party of a fainted lead plus one other has nothing to send out. No cancel.
- **Double into single** (`big-1951`): the switch is for field slot 1, which a single battle doesn't have.
  The screen offers the bench, and `SwitchSummonPhase` for field 1 crashes in `PostSummonPhasePriorityQueue`.

Single into single (the common case) and double into double work, and stay a `switch` decision.

The driver now answers the party screen of a modal `SwitchPhase` with a field slot (slot 0) when it has no
legal action or its field index is past the battle's battler count. `SwitchPhase`'s callback ignores slots
below the battler count, so the phase ends without a switch. `EncounterPhase` then queues `SummonPhase`s,
and `SummonPhase.preSummon` swaps a fainted lead for the first Pokémon able to fight, as it does whenever
a wave starts with a fainted lead. The policy loses the choice of which Pokémon leads in these cases.
Both conditions only happen for a switch left over from the last battle: inside a battle, `FaintPhase` only
queues the switch when a Pokémon off the field can fight, and party slots below the battler count are the
field.

## 3: an enemy destroyed while its assets load

Upstream, not the harness. On wave 92 of `tp100-324` the player loses The Expert Pokémon Breeder's battle,
which the run survives (`onGameOver`). `onGameOver` recalls the enemy, a Ditto transformed into the
player's Pokémon, with `leaveField(true, true, true)`:

1. `resetSummonData()` sees the Transform and calls `loadAssets(false)` to restore the sprite. Nothing awaits it.
2. `field.remove(this, true)` destroys the Pokémon right after, so its sprites are gone.
3. The load finishes later (`loadAssets` awaits its loads before `playAnim()`), and `playAnim()` throws
   in `playSprite`. The promise rejects with nothing to catch it.

In a browser that is a logged unhandled rejection and the game goes on. The driver ends the run on any
unhandled rejection while `next()` runs, and this one landed in the next wave's `NewBattlePhase`.
`restoreRealGame()` (`bridge/run.ts`) now wraps `Pokemon.loadAssets` to drop the error of a load whose
Pokémon was destroyed (`scene` unset) by the time it settles. Any other load error is still a crash.

## 4: the Commander animation (found by the batches below)

`hunt100-2727` (level 100, wave 74, a double battle) crashed in `PokemonAnimPhase.doCommanderApplyAnim`
(`TypeError ... reading 'name'`). The animation of Tatsugiri jumping into an ally Dondozo copies
`getSprite().frame.name`, and the harness's `MockSprite` has no frame until `setFrame` is called. That's
the harness, not the game. Upstream's Commander tests stub the animation out
(`triggerPokemonBattleAnim` mocked). Both Commander animations are only visuals: `CommanderAbAttr` applies
the `COMMANDED` tag and cancels Tatsugiri's move itself. The driver now ends `PokemonAnimPhase` for
`COMMANDER_APPLY` and `COMMANDER_REMOVE` without starting it, like `ScanIvsPhase`. Test on the seed.

## 5: Destiny Bond from a Pokémon moved left mid-turn (found by the batches below)

Upstream, not the harness. `night100-98394` (wave 76) and `night100-117133` (wave 69) crashed in
`MovePhase` (`TypeError ... reading 'isEnemy'`). In a double battle the player's left Pokémon fainted
before its ally Wynaut moved, and Wynaut was the last Pokémon that could fight. `FaintPhase` queues
`ToggleDoublePositionPhase`, which moves Wynaut to the left and swaps party slots 0 and 1, so its battler
index goes from 1 to 0 mid-turn. Its `MovePhase` was queued before, with Destiny Bond aimed at itself as
index 1, now the fainted ally. `getActiveTargetPokemon()` is empty. Any other move aimed at the user then
fails ("But it failed!" in `resolveFinalPreMoveCancellationChecks`), but Destiny Bond's stage-2
`failAgainstFinalBossCondition` runs first and reads `target.isEnemy()` on `undefined`. In a browser the
phase throws and the game hangs.

`restoreRealGame()` (`bridge/run.ts`) wraps that condition (only Destiny Bond uses it) to pass when there
is no target, so Destiny Bond fails like every other move aimed at the user. Both seeds now play to game
over. Test on `night100-117133`.

## Not covered

- `tp-226` was the only test of a `noLegalAction` truncation. `stall.test.ts` now makes one on purpose: a
  non-modal `SwitchPhase` with a party of one.
## Batches

The acceptance batch's level-100 seeds again (`scripts/run_games.sh 300 16 --prefix accept100 --level 100
--chunk 20`): 300 game overs, against 297 and 3 `noLegalAction` truncations before. 300 new level-100 seeds
(`--prefix fix51`): 300 game overs. Each batch took 60 s. The real-level batches were not rerun: they had no
truncations at acceptance, and their three `noLegalAction` seeds from the throughput batches are in the
table above.

Then batches on new seeds to look for anything else:

| Batch | Runs | Game over | Truncated | Waves (min / median / max) |
|---|---|---|---|---|
| `hunt`, real levels | 10,000 | 10,000 | 0 | 1 / 9 / 70 |
| `hunt100`, level 100 | 10,000 | 9,999 | 1: `hunt100-2727`, the Commander crash (fixed above) | 3 / 90 / 145 |
| `night`, real levels, with the Commander fix | 25,000 | 25,000 | 0 | |

A level-100 batch on 30 processes (`night100`) ran the machine out of memory after 5,687 runs: one batch
process is a vitest main process plus its worker, about 1.75 GB together (the worker alone ~0.95 GB by the
end of a 25-run chunk), not the ~0.75 GB heap the run records show. Memory pressure stalled every process
first, so that batch had 19 truncations, 17 of them `phaseTimeout`s of 15–128 s in ordinary phases plus one
runner `error`. Replayed, 19 of the 20 seeds play to game over. The one that repeats, `night100-4423`, is
a stalemate of the default policy, not a game bug: Charcadet with Fire Blast out of PP and only Normal and
Fighting damage left (Secret Power, Hidden Power) against Sinistea, which has only Aromatic Mist. The
default policy never switches, so the 300-turn wave cap ends it, as designed. On this machine (60 GB),
keep level-100 batches at about 14 processes and `--chunk 25`, and run long batches as their own systemd
unit with a memory cap (`systemd-run --user -p MemoryMax=32G ...`) so that an overrun can't take the
session down with it.

The rest of that batch ran that way (14 processes, `--chunk 25`, `MemoryMax=32G`, 15–23 GB used, about
4.8 runs/s, 4 h):

| Batch | Runs | Game over | Truncated |
|---|---|---|---|
| `night100` from 75,000, level 100 | 69,313 | 69,308 | 2 `crash`: the Destiny Bond bug (fixed above). 3 `waveTurnCap`: `night100-83538`, `-100889`, `-140162` |

With the 25,000 real-level runs and the 5,687 of the first `night100` attempt, that makes 100,000 runs.
The three `waveTurnCap`s look like `night100-4423`: the turn cap hit in an ordinary `TurnInitPhase`, at 16
to 21 phases per turn (a normal turn, not a loop). They weren't replayed one by one. Level-100 stalemates
of the default policy come up about once per 20,000 runs.

All of these use the default policy, which never switches by choice, throws balls, runs, buys, rerolls or
keeps a caught Pokémon, so they say nothing about states only those actions reach.
