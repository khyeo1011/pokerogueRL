# Policies on observations: findings

2026-10-17, for issue #10. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux.

**Result:** policies now get only `(observation, legal actions)`. `Driver.observe()` builds the
observation of the pending decision, and `defaultPolicy` (bridge/policy.ts) makes exactly the same
choices as the scene-reading `defaultAction` it replaces: same outcome on every seed tried at real
levels, and no differing decision at level 100. A test fails if a policy module imports game objects or
the damage calculation. The default policy still dies at the wave 8 rival on most seeds.

## Old vs new default policy

Charmander/Squirtle/Bulbasaur, `startClassicRun()`, mystery encounters off, default policy.

| Setting | Seeds | Result |
|---|---|---|
| Real levels, Set style | `wave-1` .. `wave-100` | Identical wave, turn count and decision count on every seed |
| Real levels, Switch style | `wave-1` .. `wave-30` | Identical on every seed |
| Starters at level 100, Set style | `wave-1` .. `wave-30` | Old and new computed side by side at every decision: no differing action |

Waves reached at real levels, Set style (100 seeds; the same before and after):

| Game over on wave | 6 | 7 | 8 | 9 | 10 | 13–17 | 19–25 |
|---|---|---|---|---|---|---|---|
| Runs | 1 | 10 | 52 | 8 | 9 | 17 | 3 |

The rewrite uses static move types and the enemy types the battle info shows. The old policy used
`Pokemon.getMoveType()` (which applies type-changing moves and abilities) and the enemy's true types (which
differ under Illusion). No seed hit either case.

## Runs past wave 35 are not reproducible

Level-100 runs on the same seed with the same code end on different waves from one run to the next (e.g.
`wave-6`: wave 68 once, wave 97 the next time). That is already true before this change. The cause is
upstream: `getRandomTrainerFunc()` (src/battle.ts), used for the Classic evil-team waves 35, 62, 64 and 66,
picks the trainer's gender and the 1-in-3 grunt double battle with `randInt()`, which is `Math.random()`,
not the seeded RNG. Runs at real levels end before wave 35, so they stay reproducible. Anything that
compares or replays runs past wave 35 (#9, #12) needs `Math.random` seeded or stubbed.
