# Decision points: findings

2026-10-17, for issue #7. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux.

**Result:** `bridge/driver.ts` raises a decision at every screen of a Classic run without mystery
encounters, each with its legal actions (`bridge/decisions.ts`), and `bridge/policy.ts` answers each one.
Default-policy and random-policy runs on the real game reach game over with no hang; none got stuck in
~120 runs (4–34 seeds per setting; starters at their real level, at level 40 and at level 100).

## Decisions

Every decision has `kind`, some context, and `legal: Action[]`. `Driver.act()` throws on anything not in
`legal`. Legality uses the game's own checks (so it can depend on hidden state such as an enemy's
Shadow Tag); the default policy uses only visible state.

| Decision | Raised on | Legal actions | Answered by | Default policy |
|---|---|---|---|---|
| `command` | `COMMAND`/`FIGHT` in `CommandPhase` | `move` (usable slots; slot 0 = Struggle if none; `tera: true` copies with a Tera Orb), `switch` (benched, not fainted, not trapped, not picked by the ally), `ball` (owned, wild single target, not a shielded boss, END rules), `run` (wild, not END, not trapped) | `CommandPhase.handleCommand` | best base power × STAB × effectiveness on the visible enemy types |
| `target` | `TARGET_SELECT` in `SelectTargetPhase`, single-target moves only | `target` (from `getMoveTargets`) | the mode's callback | enemy with the best score, else first |
| `switch` | `PARTY` in `SwitchPhase` (faint, U-turn, Baton Pass) | `switch` (benched, not fainted) | callback `(slot, SEND_OUT)` | first |
| `checkSwitch` | `CONFIRM` in `CheckSwitchPhase` | `stay`, `switch` | `yesHandler` then the party callback, or `noHandler` | `stay` |
| `reward` | `MODIFIER_SELECT` in `SelectModifierPhase` | `reward` (each option that some Pokémon can take), `buy` (affordable shop items that can be taken), `reroll` (affordable), `skipReward` | the mode's callback `(row, cursor)`; skip's confirm is answered yes | first `reward`, else skip |
| `itemTarget` | `PARTY` in `SelectModifierPhase` (MODIFIER, MOVE_MODIFIER, TM_MODIFIER, REMEMBER_MOVE_MODIFIER, SPLICE) | `itemTarget` (party slots passing the item's `selectFilter`; plus `move` for PP items and Memory Mushroom, `fuseWith` for DNA Splicers) | the party callback with the option the party screen would pass | first |
| `learnMove` | first `CONFIRM` in `LearnMovePhase` (4 moves known) | `learnMove` (forget slot 0–3), `skipMove` | `yesHandler` then the summary callback, or `noHandler` then yes to "stop teaching?" | replace the lowest base power × STAB move |
| `biome` | `OPTION_SELECT` in `SelectBiomePhase` (needs a Map) | `biome` | the option's handler | first |
| `evolution` | before an `EvolutionPhase` starts (if it can be cancelled) | `evolve`, `cancelEvolution` | cancel sets `EvolutionSceneUiHandler.cancelled`; "pause evolutions?" is answered no | `evolve` |
| `partyFull` | `OPTION_SELECT` in `AttemptCapturePhase` | `release` (any party slot), `keepParty` | "Yes" then the release (as `PartyUiHandler.doRelease`), or "No" | `keepParty` |
| `revive` | `PARTY` in `RevivalBlessingPhase` | `revive` (fainted slots) | callback `(slot, REVIVE)` | first |
| `gameOver` | before `GameOverPhase` starts | none; `victory` says whether the run was won | | |

Screens that are steps of one choice are folded into one decision, so the agent never sees a half-made
choice: `learnMove` covers the yes/no prompt and the summary, `checkSwitch` the prompt and the party
screen, `partyFull` the menu and the release screen. Spread moves skip `target`: their target screen only
confirms.

**Not exposed:** held-item transfer, "check team" and the rarity lock on the reward screen; cancelling
the item-target screen (a reward is only legal if some Pokémon can take it, so there is always a
target); cancelling a doubles command back to the first Pokémon; pausing evolutions. There is no nickname
prompt in this version.

## Run results

`bridge/test/full-run.test.ts`, Charmander/Squirtle/Bulbasaur, mystery encounters off:

| Runs | Reached |
|---|---|
| Real game, default policy (34 seeds) | game over on wave 7–10 (most on wave 8, the rival), one each on 16, 17 and 20 |
| Starters at level 40, default policy (10 seeds) | game over on wave 38–66 |
| Starters at level 100, default policy (14 seeds) | game over on wave 60–95 |
| Starters at level 100, random legal actions (18 seeds) | game over on wave 17–55 |
| Real game, random legal actions (20 seeds) | game over on wave 2–8 |

Between them these saw every decision kind and every action kind. No action the legal lists allowed was
refused by the game (no "can't escape/catch/switch" messages in the random runs). Wave 8 is where the
default policy stops on the real game: only the lead earns EXP, and the rival's team outlevels it.

## Surprises

- **The harness plays in Set mode; the game defaults to Switch.** `SettingsHelper` sets
  `battleStyle: SET`, so `checkSwitch` never appears unless a test sets `BattleStyle.SWITCH`. The
  full-run tests use both. Which one the env uses is a choice for later.
- **Evolutions play by themselves.** The only input is pressing cancel during the animation, which sets
  a flag the phase reads when the cycle ends. Raising the decision when the scene opens would race the
  animation, so the driver asks before starting the phase and sets the flag once the scene is up.
- **A shop purchase doesn't change the UI mode.** The screen stays, so no mode hook fires. After a
  purchase the driver raises the reward screen again once the phase has applied the item (a microtask
  queued in the same mode-change continuation runs after the phase's own `.then`).
- **Declining a TM brings the reward screen back.** `SelectModifierPhase` queues a copy of itself when a
  TM or Memory Mushroom is picked, and `LearnMovePhase` only removes it if the move is learned. A policy
  that picks the TM and then always skips the move loops forever. The default policy always learns.
- **Shop items have no `id`.** `getPlayerShopModifierTypeOptionsForWave` builds them without
  `withIdFromFunc`; the driver takes the key from their locale key (`modifierType:ModifierType.POTION`).
- **The moveset override hides learned moves.** With `game.override.moveset()`, `getMoveset()` keeps
  returning the override after a move is learned. Tests that learn moves use `game.move.changeMoveset()`.
- **`ScanIvsPhase` throws in the harness** (mock sprites have no `name`), so the driver skips it. The IV
  Scanner only shows enemy IVs.
- Picking a reward right after the screen opens, before its animations finish, works headless.

## Left for later

- Mystery encounters (#8). Also there: `GameOverPhase` can be survived in some encounters
  (`onGameOver`), but the driver reports `gameOver` before starting it; and eggs, which only arrive
  through encounters in a fresh save, would stop at `EggLapsePhase`'s "skip hatching?" prompt.
- A watchdog (#9). Tests use `nextDecision()` in `bridge/test/play.ts`, which fails with the phase and
  UI mode after 15 s without a decision.
- Policies on observations only (#10). `defaultAction(scene, decision)` reads the scene directly.
