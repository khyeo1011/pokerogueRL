// Boots a Classic run of the real game (issue #3). The test harness changes the game to make tests
// deterministic. This undoes each change and seeds the game's own RNG per run instead.
//
// Where the harness changes the game, and how it is undone here:
//   - Max rolls for damage and every other battle roll: GameManager's constructor replaces
//     BattleScene.prototype.randBattleSeedInt. restoreRealGame() puts upstream's body back.
//   - No mystery encounters: GameManager.initDefaultOverrides() mocks the encounter rate to 0.
//     restoreRealGame() restores the mock.
//   - IVs of 31, Hardy natures, no shinies, no enemy starting items: applied by
//     classicMode.runToSummon(). startClassicRun() boots without it.
//   - Seed "test" on every run: set by generateStarters(). startClassicRun() sets the run's seed.

import { BattleScene } from "#app/battle-scene";
import { getGameMode } from "#app/game-mode";
import { activeOverrides } from "#app/overrides";
import { GameModes } from "#enums/game-modes";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import type { GameManager } from "#test/framework/game-manager";
import { generateStarters } from "#test/utils/game-manager-utils";
import { vi } from "vitest";

/** Undo the game changes made by GameManager's constructor. Call after each `new GameManager()`. */
export function restoreRealGame(): void {
  // Upstream's body (src/battle-scene.ts). The original can't be saved at import instead: vitest runs
  // with isolate: false, so a GameManager from an earlier test file may already have replaced it.
  BattleScene.prototype.randBattleSeedInt = function (
    this: BattleScene,
    range: number,
    min = 0,
  ) {
    return this.currentBattle?.randSeedInt(range, min);
  };
  vi.spyOn(
    activeOverrides,
    "MYSTERY_ENCOUNTER_RATE_OVERRIDE",
    "get",
  ).mockRestore();
}

/**
 * Boot a Classic run of the real game with `speciesIds` as starters and its RNG seeded from `seed`.
 * Stops after wave 1's EncounterPhase ends, like `classicMode.runToSummon()`, so a Driver can take over.
 */
export async function startClassicRun(
  game: GameManager,
  seed: string,
  ...speciesIds: SpeciesId[]
): Promise<void> {
  restoreRealGame();
  await game.runToTitle();

  game.promptHandler.addToNextPrompt("TitlePhase", UiMode.TITLE, () => {
    const scene = game.scene;
    scene.gameMode = getGameMode(GameModes.CLASSIC);
    scene.setSeed(seed);
    scene.resetSeed();
    const starters = generateStarters(scene, speciesIds);
    scene.setSeed(seed);
    scene.phaseManager.pushNew("EncounterPhase", false);
    new SelectStarterPhase().initBattle(starters);
  });

  await game.phaseInterceptor.to("EncounterPhase");
  // generateStarters() skips the starter-select UI, which is what normally fills player movesets.
  for (const pokemon of game.scene.getPlayerParty()) {
    pokemon.generateAndPopulateMoveset();
  }
}
