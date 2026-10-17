# Random starter teams: findings

2026-10-17, for issue #4. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux.

**Result:** `bridge/team.ts` `randomTeam(seed)` draws a Classic starter team, as if every starter were
unlocked, within the 10-point budget. The same seed always gives the same team, whatever the state of
`Math.random` or the game's RNG. Use it as `startClassicRun(game, seed, ...randomTeam(seed))`.
`bridge/test/team.test.ts` checks it over 5000 seeds and boots three teams in the real game.

## How the game builds a team

| Rule | Where | Value |
|---|---|---|
| Starters | `speciesDataRegistry.getAllStarters()`: every species with a `starterCost` | 572 species, base forms plus regional ones (e.g. `GALAR_FARFETCHD`) |
| Cost | `speciesDataRegistry.getStarterCost(id)`; `gameData.getSpeciesStarterValue()` lowers it by candy reductions | 1 to 10 |
| Budget | `getRunValueLimit()` in `src/ui/utils/starter-select-ui-utils.ts` | 10 in Classic, 15 in Endless, changed by challenges |
| Party size | `PLAYER_PARTY_MAX_SIZE` | 6 |
| Duplicates | `isInParty()` in starter select | not allowed |
| Classic exclusions | `filterStarters()` hides starters only in Challenge mode | none |

The starter-select screen has a random button (`processRandomCursorInput`). Each press adds one starter,
chosen uniformly (`Math.random`) among those that are caught, valid for the challenge, not in the party,
and fit the points left. It refuses at 6 Pokémon or when nothing fits.

## The draw

`randomTeam` presses that button until it refuses, with every starter caught, base costs (no candy
reductions: they're save data) and its own RNG. Since 26 starters cost 1, nothing fits only when all
10 points are spent. So every team has 6 Pokémon or uses exactly 10 points.

The RNG is a `Phaser.Math.RandomDataGenerator` seeded with `"team:" + seed`. The prefix matters:
`resetSeed()` sows `Phaser.Math.RND` with the run seed itself at wave 0, so without it, a team drawn from
the run's seed would replay the start of the game's own stream.

Starters by cost:

| Cost | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Starters | 26 | 128 | 192 | 94 | 23 | 52 | 29 | 17 | 10 | 1 |

Over seeds `train-0` .. `train-99999`:

| Team size | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Teams | 167 | 13,452 | 36,356 | 39,136 | 10,199 | 690 |

All 572 starters appear. 93,845 of the 100,000 teams are distinct as sets of species.

The first pick is uniform over all starters, so a team holds an expensive starter about as often as the
starter list does (10% of starters cost 7 or more). Later picks lean cheap, because fewer expensive
starters still fit.

## Held-out teams

Convention: training uses seeds `"train-<n>"`, evaluation uses `"eval-<n>"`. Numbers and strings are
seeded by their text (`7` and `"7"` give the same team), so a prefix keeps the two sets apart.

Disjoint seeds don't give disjoint teams. 84 of the teams for `eval-0` .. `eval-999` (8.4%) also appear,
as a set of species, among the 100,000 training teams. They're small teams built around an expensive
starter: 79 of the 84 have one or two Pokémon, and 83 hold a starter costing 6 or more. There are few
such teams. One cost-10 starter on its own is a single team, and a cost-9 starter plus a cost-1 starter
is one of 260. A strict held-out set needs to drop teams that training has seen. Nothing does that yet.
