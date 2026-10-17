# Phase 1 acceptance: 300 random-team runs without a hang

2026-10-17, for issue #12. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19.0, Ryzen 9 9950X3D (16 cores,
32 threads). Branch stacked on #45 (stall detection) and #46 (throughput).

**Result: passed.** 300 random-team runs of the real game with mystery encounters on (default rate)
all ended in game over: no truncations, no lost runs, no killed processes. A second batch of 300 with
the starters at level 100, so that runs reach the mystery encounter waves (10–180) and meet 5 encounters
each on average, had 297 game overs and 3 truncations. All 3 are the same upstream softlock, caught and
logged by the driver as `noLegalAction`. Nothing hung.

## Commands

Seeds `accept-0 .. accept-299` and `accept100-0 .. accept100-299`, not used before. Default policy,
`randomTeam(seed)`, `startClassicRun()` (real RNG, mystery encounters on), default stall limits.

```bash
scripts/run_games.sh 300 8 --prefix accept --out runs/accept-real
scripts/run_games.sh 300 16 --prefix accept100 --level 100 --chunk 20 --out runs/accept-l100
```

Summaries and the per-run records (trimmed: no heap or phase counts) are in
`notes/2026-10-17-phase1-acceptance/`.

## Results

| | Real levels | Level 100 |
|---|---|---|
| Runs | 300 | 300 |
| Game over | 300 | 297 |
| Truncated (caught and logged) | 0 | 3, all `noLegalAction` |
| Lost (process stuck or died) | 0 | 0 |
| Processes killed / non-zero exits | 0 / 0 (8 processes) | 0 / 0 (16 processes) |
| Wave (min / median / max) | 3 / 9 / 55 | 13 / 90 / 115 |
| Turns (median / mean / max) | 30 / 37 / 110 | 158 / 158 / 288 |
| Most turns in one wave (cap 300) | 22 | 80 |
| Most phases in one `next()` | 62 | 85 |
| Decisions per run (median / max) | 58 / 322 | 398 / 644 |
| Play time per run (median / max) | 0.25 / 1.3 s | 2.3 / 4.4 s |
| Boot per run (median) | 104 ms | 108 ms |
| Elapsed | 26 s | 61 s |
| Per worker: games/h, env steps/s | 7,762, 177 | 1,451, 157 |
| Aggregate env steps/s (incl. startup) | 947 | 1,917 |
| Mystery encounters (runs with one) | 77 (56 runs) | 1,492 (298 runs) |

Waves reached, real levels: 1–7: 47, 8 (the rival): 101, 9–10: 47, 11–20: 55, 21–35: 38, 36–60: 12.
Level 100: 1–20: 3, 21–40: 4, 41–60: 14, 61–80: 84, 81–90: 57, 91–100: 100, 101–115: 38. No run won.

Throughput matches `notes/2026-10-17-throughput.md`. The level-100 per-worker rate is below that note's
fresh-process figure because 16 processes start at once (7.3 s startup) for ~19 runs each.

## Mystery encounters met

Encounters met on waves 12–113. 26 of the 31 types were met:

| Encounter | Real levels | Level 100 |
|---|---|---|
| Mysterious Challengers | 6 | 133 |
| Delibirdy | 3 | 127 |
| Fight or Flight | 2 | 110 |
| Mysterious Chest | 6 | 108 |
| Shady Vitamin Dealer | 2 | 108 |
| Uncommon Breed | 8 | 106 |
| Berries Abound | 4 | 105 |
| Training Session | 13 | 103 |
| The Pokémon Salesman | 1 | 91 |
| Fun and Games | 6 | 86 |
| Department Store Sale | 7 | 55 |
| Teleporting Hijinks | 1 | 49 |
| Global Trade System | 10 | 47 |
| Part-Timer | 5 | 45 |
| Bug-Type Superfan | | 35 |
| Dancing Lessons | | 29 |
| The Expert Pokémon Breeder | | 27 |
| Dark Deal | | 24 |
| Slumbering Snorlax | 2 | 23 |
| Safari Zone | 1 | 23 |
| Weird Dream | | 23 |
| Clowning Around | | 23 |
| Lost at Sea | | 4 |
| Absolute Avarice | | 3 |
| The Strong Stuff | | 3 |
| Fiery Fallout | | 2 |
| **Total** | **77** | **1,492** |

Not met: Field Trip and An Offer You Can't Refuse, which this version never spawns
(`notes/2026-10-17-mystery-encounters.md`), and A Trainer's Test, Trash to Treasure and The Winstrate
Challenge, which spawn only on waves 100–180: 38 runs got past wave 100, and none of them met one.

## The truncations: a forced switch left over into a double battle

All 3 level-100 truncations (`accept100-57` wave 79, `accept100-144` wave 75, `accept100-229` wave 65)
end in `SwitchPhase` with the party screen up and no legal action. The throughput batches hit the same
thing on 6 more seeds, every time they were played (`tp-226` on wave 2, `tp-643`, `tp-1069`, `tp100-323`,
`tp100-564`, `tp100-630`). Replaying `tp-226` and `tp100-630` with a trace shows how:

1. The player's Pokémon on the field faints together with the last enemy (Struggle recoil in `tp-226`).
   The party has one more Pokémon, on the bench of the single battle.
2. `FaintPhase` queues a forced switch (`SwitchPhase`, field index 0) for it. The battle is already won,
   so that phase runs after the reward screen, in the next battle.
3. The next battle is a double one. With 2 battlers, party slot 1 counts as a field slot: the party
   screen offers Send Out only for slots 2 and up (`PartyUiHandler`, `FAINT_SWITCH`), and
   `SwitchPhase`'s callback ignores lower slots. The party only has slots 0 (fainted) and 1. Cancel isn't
   allowed on this screen.

A human player would be stuck on this screen too, so this is upstream, not the bridge. It is the same
family as `big-1951` in `notes/2026-10-17-stall-detection.md` (a `FaintPhase` switch that runs in the
next battle). The driver sees a decision with no legal action and ends the run as `truncated`
(`noLegalAction`) with a stall report, and the batch goes on. Rate: 0 of 300 here at real levels (3 of
3,200 in the throughput batches), 3 of 300 at level 100 (3 of 800 there).

Not changed here. If the rate matters for training, the driver could answer this one screen with a field
slot: `SwitchPhase` then ends without switching, and wave start's `SummonPhase` swaps the fainted lead for
the Pokémon left (`preSummon`). That is a move the real UI doesn't offer, so it needs its own decision.

The throughput batches also had one `crash`, on `tp100-324` (wave 92, `NewBattlePhase`): `TypeError:
Cannot read properties of undefined (reading 'play')` in `EnemyPokemon.playSprite`, from `loadAssets`
resuming after its asset load. The enemy's sprite was gone by then. It replays the same way every time,
is caught and logged as `crash`, and wasn't investigated further.

## Phase 1 milestone checklist

"Done when 300 random-team runs with mystery encounters on finish without a hang."

| Criterion | Status |
|---|---|
| 300 runs | Yes: 300 at real levels, plus 300 at level 100 |
| Random teams | Yes: `randomTeam(seed)`, 10-point Classic budget (#4) |
| Real game, mystery encounters on | Yes: `startClassicRun()`, default encounter rate; 77 encounters at real levels, 1,492 at level 100, 26 types |
| Finish without a hang | Yes: every run ended as game over or as a caught, logged truncation. 0 lost runs, 0 killed processes, every process exited 0 |
| Stalls caught and logged (issue #12) | Yes: 0 at real levels; 3 at level 100, all `noLegalAction` (an upstream softlock), with stall reports in the run records |
| Stall count, wave reached, throughput summarized (issue #12) | Yes: above |
