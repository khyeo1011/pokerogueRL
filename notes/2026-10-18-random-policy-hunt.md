# Hunting game bugs with a random policy

2026-10-18, for issue #53. pokerogue v1.12.1.1 (`bdfbef6`).

**Result:** 170,000 runs of a uniformly random policy found four game bugs, all now worked around in
`bridge/` with a test on the seed. The first 20,000 (10,000 at real levels, 10,000 at level 100) found none.
An overnight batch of 150,000 more at level 100 found five truncations: three crashes and two stalemates,
from four causes, all upstream game logic. Unlike the default policy's 100,000 runs
(`notes/2026-10-17-leftover-switch-and-late-load.md`), these runs switch, throw balls, run, buy, reroll,
release and keep caught Pokémon, cancel evolutions and pick biomes, in nearly every level-100 run. The
bugs need exactly such odd sequences, about one in 30,000 runs.

## The random policy, recorded actions, replay

- `randomPolicy(seed)` (`bridge/policy.ts`) picks uniformly among the legal actions, from its own RNG
  seeded from `"policy:" + seed`. It draws nothing from the game's RNG or `Math.random` (which
  `startClassicRun` seeds for the game), so a run replays from its seed and the policy, and the policy's
  draws don't shift the game's. It can't use Phaser's RNG: a policy may import only types, static data and
  enums (`policy-imports.test.ts`).
- `scripts/run_games.sh --policy random` (`BATCH_POLICY` in the batch runner). Each record now has `policy`
  and `actionKinds` (actions taken, by kind), and the summary totals `actionKinds` and
  `runsWithActionKind`.
- A truncated (or `error`) run's record has `actions`: every action the policy took, in order. A trained
  agent's run can't be replayed from its seed alone, so this is what a training truncation needs too.
  Only those runs keep them: a level-100 run takes ~340 actions.
- `scripts/replay_runs.sh RECORDS` replays every record in a file that has `actions` (`BATCH_REPLAY`):
  same seed, level and actions, through `replayPolicy`, which throws when the actions run out, while
  `Driver.act` throws on an illegal one, so a replay that diverges fails instead of drifting.
  Check: `night100-4423` (the default policy's level-100 stalemate) truncated, then replayed from its
  record, gives the same `waveTurnCap` on wave 57 after 382 turns, 561 decisions and the same 561 actions.
  `bridge/test/random-policy.test.ts` plays a random-policy run and replays it from its actions, and
  checks that the two decision traces match.

## Batches

```bash
scripts/run_games.sh 10000 16 --policy random --prefix rhunt --out runs/rhunt
scripts/run_games.sh 10000 14 --policy random --level 100 --chunk 25 --prefix rhunt100 --out runs/rhunt100
```

Both ran in a `systemd-run --user -p MemoryMax=32G` unit, as the last note advises. Such a unit doesn't
get the login shell's `PATH`, so pass `-E PATH="$PATH"` or the launcher can't find `corepack` (nvm).

| Batch | Runs | Game over | Truncated | Waves (min / median / max) | Decisions (median) | Elapsed |
|---|---|---|---|---|---|---|
| `rhunt`, real levels, 16 processes | 10,000 | 10,000 | 0 | 1 / 7 / 30 | 54 | 5.5 min |
| `rhunt100`, level 100, 14 processes | 10,000 | 10,000 | 0 | 7 / 47 / 95 | 343 | 30 min |

The random policy loses sooner than the default one (median wave 7 against 9 at real levels, 47 against
90 at level 100). Per worker, level 100 ran at ~1,590 games/h and ~150 env steps/s.

### What the runs reached

`actionKinds` came after these batches, so it was counted on a rerun of the same seeds (runs are
deterministic per seed): all 10,000 `rhunt` seeds, and the first 2,000 `rhunt100` seeds. Runs that took
each kind at least once:

| Action | Real levels (of 10,000) | Level 100 (of 2,000) |
|---|---|---|
| `switch` | 9,941 | 2,000 |
| `run` | 9,657 | 2,000 |
| `ball` | 9,287 | 1,992 |
| `buy` | 3,643 | 1,994 |
| `release` (keep a caught Pokémon) | 3,433 | 1,911 |
| `keepParty` | 844 | 1,225 |
| `reroll` | 367 | 1,652 |
| `learnMove` / `skipMove` | 1,464 / 442 | 1,928 / 1,519 |
| `evolve` / `cancelEvolution` | 25 / 22 | 1,176 / 1,014 |
| `meOption` / `mePokemon` / `meSubOption` | 53 / 9 / 7 | 1,897 / 883 / 445 |
| `biome` | 0 | 226 |
| `revive` (Revival Blessing) | 0 | 5 |

Every action kind but `stay` was taken. `stay` answers `checkSwitch`, which never comes up with the game's
`battleStyle: SET` (`notes/2026-10-17-decision-points.md`). Tera moves count as `move`. Real-level runs
rarely get far enough for the shop, rerolls or a biome choice, so level 100 is the better hunting ground.

## Overnight batch: 150,000 runs at level 100

`rhunt100-10000` to `rhunt100-159999`, in 25 batches of 6,000 with 30 processes (`--chunk 25`), from 02:50
to 09:48 on a 32-thread machine:

```bash
scripts/run_games.sh 6000 30 --policy random --level 100 --chunk 25 --prefix rhunt100 --start <n> --out <dir>
```

Each batch took ~1,000 s, about 21,500 games/h, or ~720 games/h per process (less than half the 14-process
rate, since 30 processes share 32 threads). The median run reached wave 47 in 342 decisions; the best
reached wave 109.

| Outcome | Runs |
|---|---|
| Game over | 149,989 |
| Truncated | 5 (3 `crash`, 2 `waveTurnCap`) |
| Lost | 6 |

The lost runs (`36899`, `44099`, `55174`, `129574`, `136099`, `138599`) were V8 heap OOMs from the 512 MB
heap cap below. Each was the last run of its 25-run chunk, after the process's heap had grown
over the chunk. `36899` alone plays to game over, with a 310 MB heap. They are not game bugs. A shorter
`--chunk` would avoid them.

### Memory at 30 processes

Without a heap cap, 30 processes reached the unit's 47 GB `MemoryMax` within minutes. The cgroup OOM
killer then stopped the whole unit, since systemd's default `OOMPolicy=stop` ends a unit when the kernel
kills one of its processes. With `NODE_OPTIONS=--max-old-space-size=512`, a process that outgrows its heap
dies alone (the runner records its run as `lost`), and the batch peaked at 41.7 GB. The unit's settings:

```bash
systemd-run --user --unit=hunt -p MemoryMax=42G -p MemoryHigh=40G -p MemorySwapMax=0 -p OOMPolicy=continue \
  -E PATH="$PATH" -E HOME="$HOME" -E NODE_OPTIONS=--max-old-space-size=512 --working-directory="$PWD" \
  systemd-inhibit --what=sleep:idle --mode=block --why=batch bash -c 'scripts/run_games.sh ...'
```

The kernel never killed anything (`memory.events` `oom_kill 0`). To keep the unit running after logout,
the user session needs `loginctl enable-linger`.

## Bugs found and fixed

Each truncated run replayed from its recorded actions (`scripts/replay_runs.sh`, `replayPolicy`) to the same
failure. The traces below come from those replays. Each fix has a test on its seed in `bridge/test/stall.test.ts`, and
each test fails with its fix turned off.

1. **A status cure for an enemy the flee destroyed** (`rhunt100-35850`, wave 31, crash in
   `EnemyPokemon.playSprite`). This was a double wild battle against Koffing (Neutralizing Gas) and a
   sleeping Murkrow (Insomnia, suppressed by the gas). The player ran. Fleeing applies `PreLeaveFieldAbAttr`,
   which ends the gas, so Insomnia cures Murkrow's sleep and queues a `ResetStatusPhase`. The flee destroys
   both enemies, and the phase then plays an animation on a sprite that is gone. The harness's tweens end at
   once, so the destroy may come sooner than in a browser, where the 250 ms flee tween would still be
   running. Fix (`bridge/run.ts`): `ResetStatusPhase` ends without clearing the status of a destroyed Pokémon
   (`scene == null`).
2. **Damage to an off-field Future Sight user** (`rhunt100-68195`, wave 45, and `rhunt100-138254`, wave 13;
   crash in `DamageNumberHandler.add`). A Future Sight that lands after its user switched out can hurt the
   user back: on wave 45, an enemy Cramorant's Gulp Missile; on wave 13, a fainting Pyukumuku's Innards Out
   (`PostFaintHPDamageAbAttr`). `damageAndUpdate()` then queues a `DamageAnimPhase` at the user's battler
   index, which is -1 off the field, and the phase finds no Pokémon there. This would crash a browser too.
   Fix (`bridge/run.ts`): `DamageAnimPhase` ends without its animation when no Pokémon is at its battler
   index, since the damage was already dealt. It ends as a `PokemonPhase`, because its own `end()` would
   start the final boss's second phase for the missing Pokémon.
3. **A party of seven** (`rhunt100-117628`, wave 55, `waveTurnCap`). The Expert Pokémon Breeder (wave 42)
   leaves only the chosen Pokémon in the party for its battle. The chosen Nincada evolved there, so
   `validateShedinjaEvo()` saw a party of one and added a Shedinja, and the party came back with seven. The
   seventh can't be sent out: `SwitchPhase` only takes slots 0-5, and on the party screen, cursor 6 is
   Cancel. On wave 55, sending out slot 6 after a faint did nothing, and the enemy's Noctowl attacked a
   fainted Shedinja until the 300-turn cap, while no Pokémon could take a command. Filtering slot 6 out of the legal
   switches only moved the stall: in the replay with the filter, the seventh Pokémon was later the last one
   able to fight. Fix (`bridge/run.ts`): the Shedinja check also counts the Pokémon the encounter holds
   aside (`encounter.misc.originalParty`), so the party stays at six.
4. **Two faints sending out the same Pokémon** (`rhunt100-113244`, wave 62, `waveTurnCap`). This was a
   trainer double battle. Both player Pokémon fainted in the same turn as an enemy, leaving Medicham as the
   only Pokémon to send out. `SwitchSummonPhase` is a dynamic phase, run in speed order rather than queue
   order. So the enemy's replacement switched in first, the second faint's party screen came before
   Medicham's switch-in, and it offered Medicham again. The second switch-in then swapped the fainted
   Pawniard back in, and the battle went on with two fainted Pokémon on the player's side. A browser offers
   the same choice. Fix (`bridge/decisions.ts`): a Pokémon that a queued `SwitchSummonPhase` will send in is
   no longer a legal switch. With nothing left to offer, the driver answers the screen with a field slot,
   which ends it without a switch. That is the state the game reaches when the switch-ins run in order.

With the fixes, all five seeds play to game over, and so did 6,000 new runs (`rhunt100-160000` to
`rhunt100-165999`, same settings, 17 min, peak 38.7 GB).

## Not covered

- Late Classic waves: the random policy's best run reached wave 109, and the default policy covers waves
  past that (its level-100 runs reach 145). A policy that plays well but makes random choices outside
  battle (e.g. default moves, random rewards and catches) would reach later waves with the extra actions.
- Training-side containment from #53 (a bridge restart on socket timeout, `runs/<run>/truncations.jsonl`,
  truncation rate by signature in the logs) waits for the real server (#20) and the training logs (#21).
  The bridge side is ready for it: a truncated decision carries its stall report, and the env can record
  the actions it sent.
- One unexplained test failure: `run.test.ts` "gives the same Pokémon for the same seed" failed once, in
  the first full-suite run of this branch. Its assertion diff wasn't kept. It then passed in 61 full runs
  (16 of them in shuffled file order, with and without the new test file). Ruled out: more `Math.random`
  draws under CPU load (36 boots of one seed with every thread busy: one draw each, the same Pokémon), and
  the clock (no timed event boundary near the date; time of day comes from the wave). If it shows up again,
  the diff says which of species, IVs, nature or shiny differed.
