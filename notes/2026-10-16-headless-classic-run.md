# Headless Classic run: findings

2026-10-16, for issue #1. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, pnpm 10.34.5, Linux.

**Result:** pokerogue's vitest harness (`GameManager`) runs a Classic game headlessly from outside
`pokerogue/`, with no species or move overrides, through to a real game over.
`bridge/test/classic-run.test.ts` is the smoke test; run it with `scripts/test_bridge.sh`.

A typical run, with starters Charmander/Squirtle/Bulbasaur always using their highest-power move:

```
wave 1 (WILD): beat Tandemaus L2
wave 2 (WILD): beat Zigzagoon L2
wave 3 (WILD): beat Bellsprout L3
wave 4 (WILD): beat Wooloo L4
wave 5 (TRAINER): beat Bidoof L4, Sentret L4
  Charmander fainted, sent in Squirtle
wave 6 (WILD): beat Purrloin L5
game over on wave 7
```

The run exercised: reward screens, EXP and level-ups, a double battle, a trainer sending in its next
Pokémon, forced switches after a faint, and game over → back to the title screen.

## Issue #1 checklist

| Task | Status |
|---|---|
| Fork `pagefaultgames/pokerogue` @ v1.12.1.1 | Pinned at v1.12.1.1, but `.gitmodules` points at upstream directly, not a fork. Fine while we keep it read-only. |
| Node + pnpm | The issue says Node 22, but this pokerogue version requires Node ≥ 24.9 (`engines` in its `package.json`). The README already says so. |
| Submodules + `pnpm install` | Done by `scripts/setup.sh`. `assets` is required too, not just `locales`: without it, `BattleScene` preload fails and every test times out. |
| `GameManager` starts a Classic run headless | Yes. See above and the smoke test. |
| Document in README | Not yet. |

## Running game code from outside `pokerogue/`

Three workarounds are needed, all now in `bridge/`:

- **`#alias` imports:** Vite resolves tsconfig `paths` from the tsconfig nearest the importing file.
  `bridge/tsconfig.json` extends pokerogue's, so its paths still resolve relative to `pokerogue/`.
- **Bare imports** (`vitest`, `phaser`): Vite searches `node_modules` upward from the importing file.
  `bridge/node_modules` is a committed symlink to `../pokerogue/node_modules`.
- **Config loading:** `bridge/vitest.config.ts` wraps pokerogue's config.
  - With the default `bundle` loader, the `namespaces-i18next` plugin crashes: `magic_string.default is not a constructor`.
  - With the `runner` loader, the config fails with `Vite module runner has been closed` (in pokerogue's `vite.config.ts`).
  - The `native` loader works: Node 24 strips the types, and pokerogue's configs import with explicit `.ts` extensions.

## Gotchas for the real bridge

1. **Starters start with no moves.** `Pokemon`'s constructor leaves player movesets empty
   (`src/field/pokemon.ts`, `if (!dataSource)` branch), because the starter-select UI fills them in.
   `generateStarters()` in the test utils skips that UI. Upstream tests never notice because they always
   use `.moveset(...)` overrides. The smoke test calls `generateAndPopulateMoveset()`, which gives *random*
   level-appropriate movesets, not the game's default starter moves. The bridge should reproduce what
   starter select does.
2. **The harness changes the game by default:**
   - `BattleScene.prototype.randBattleSeedInt` is patched to always return the maximum (in `GameManager`'s
     constructor), so every damage roll is the max for both sides.
   - Mystery encounters are turned off (`mysteryEncounterChance(0)` in `initDefaultOverrides`).
   - `runToSummon` sets IVs to 31 and natures to Hardy (`normalizeIVs` / `normalizeNatures` default on).
   - `scene.seed` is fixed to `"test"` in `generateStarters`.

   All of these need undoing before training on the real game.
3. **Runs are not reproducible.** The seed is fixed, yet the same test ended on wave 7 in some runs and
   wave 8 in others, after different numbers of turns. Some game code must use an unseeded random source
   (not tracked down yet). Seeded reproducibility will need work.
4. **Game over makes the harness hang.** On a wipe the game runs `GameOverPhase` → `PostGameOverPhase` →
   `TitlePhase` and waits at the title screen, while `phaseInterceptor.to("TurnEndPhase")` waits for its
   target until `TEST_TIMEOUT` (20s). The smoke test spies on `GameOverPhase.prototype.start` and throws,
   which makes `vi.waitUntil` reject immediately. The bridge needs its own game-over check to end episodes.
5. **Trainer replacements come after `TurnEndPhase`.** After an enemy faints in a trainer battle, the next
   Pokémon arrives in a `SwitchSummonPhase` after `TurnEndPhase`. So step to the next `CommandPhase`, not
   to end of turn, before reading state.
6. **Doubles need a command and a target for each active Pokémon.** Otherwise `CommandPhase` waits for the
   second slot until it times out.
7. **Stalemates happen.** In one run Sand Attack took Charmander to −6 accuracy against a Purrloin that
   only used Growl and Sand Attack, and the fight went 50+ turns. The env needs a truncation limit.
   (The smoke test caps a run at 150 turns.)

## Performance

- Boot to first turn: about 0.7s; vitest/jsdom startup adds about 6s of transform and setup before that.
- About **3.7–8.4 turns/s** on one core, depending on the battles. Long fights run near the top of that
  range. Runs where most turns end a wave are slower, so wave transitions (EXP, rewards, the next
  encounter) are the expensive part.
- Untested idea: much of the cost may be the harness itself. `PhaseInterceptor.run` checks every 50 ms
  whether a phase that isn't done yet has finished (`test/framework/phase-interceptor.ts`). A bridge that
  drives `phaseManager` directly could be much faster. Profile before building on the upstream helpers.

## Design notes for the bridge

The upstream helpers (`toNextTurn`, `toNextWave`, `onNextPrompt`) advance the game by naming the next
phase. RL needs the opposite: run until the game wants input, then report what it wants. The decision
points seen here are UI modes:

- `COMMAND` / `FIGHT` / `TARGET_SELECT`: battle actions.
- `PARTY`: forced switch after a faint.
- `MODIFIER_SELECT`: rewards. The smoke test always skips the reward.

Still to handle: learning a 5th move, evolution prompts, catching (`BALL`), and mystery encounters.
