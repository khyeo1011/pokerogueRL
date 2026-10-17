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
//   - Destroyed game objects stay in their containers. The scene's containers (the field, the field UI)
//     are mocks whose add() doesn't listen for the child's destroy event, as Phaser's Container does. So a
//     destroyed Pokémon stays on the field with no sprites: isOnField() is still true, and an animation
//     aimed at it throws. That happens after fleeing a double battle, when a trap's damage animation at
//     turn end targets an enemy the flee destroyed (`CommonBattleAnim.play`, "reading 'setPosition'").
//     It also keeps every destroyed Pokémon and battle info reachable from the scene, which the harness
//     reuses for every GameManager. restoreRealGame() makes the mock containers drop destroyed children.
//   - Mock objects and sprites pile up: the mock texture manager keeps every object it creates in a list
//     nothing reads, and the Tera sparkle handler only forgets destroyed sprites on a tween repeat, which
//     the mock tweens never fire. Each mock sprite wraps a real Phaser sprite, which listens on the
//     global animation manager until destroyed, and the UI drops many without destroying them. That list
//     of listeners grew by ~1,000 per run, and every sprite destroyed searches it, so a process got slower
//     with each run until, after ~100 runs, a run took minutes. restoreRealGame() empties all three (the
//     listener only stops a sprite whose animation is removed from the manager, which never happens).
//
// The game's own RNG is seeded from the run's seed. Some game code uses Math.random instead (trainer
// gender and evil-team doubles in getRandomTrainerFunc(), used on Classic waves 35, 62, 64 and 66), so
// startClassicRun() also replaces Math.random, for the rest of the test, with a generator seeded from
// the run's seed. With both, a run can be replayed from its seed and policy.

import { BattleScene } from "#app/battle-scene";
import { getGameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { GameModes } from "#enums/game-modes";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import type { GameManager } from "#test/framework/game-manager";
import { MockContainer } from "#test/mocks/mocks-container/mock-container";
import { generateStarters } from "#test/utils/game-manager-utils";
import Phaser from "phaser";
import { vi } from "vitest";

/** Marks MockContainer.prototype as patched by dropDestroyedChildren(), which happens once per process. */
const MOCK_ADD = Symbol("dropsDestroyedChildren");

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
  (globalScene.textures as unknown as { list: unknown[] }).list.length = 0;
  globalScene["spriteTeraSparkleHandler"].removeAll();
  globalScene.anims.removeAllListeners(Phaser.Animations.Events.REMOVE_ANIMATION);
  if (!(MOCK_ADD in MockContainer.prototype)) {
    dropDestroyedChildren();
  }
}

/** Make MockContainer remove a (real Phaser) child when the child is destroyed, like Container.addHandler. */
function dropDestroyedChildren(): void {
  const proto = MockContainer.prototype as MockContainer & { [MOCK_ADD]?: true };
  const { add, addAt } = proto;
  const listen = (container: MockContainer, obj: unknown) => {
    for (const child of Array.isArray(obj) ? obj : [obj]) {
      if (child instanceof Phaser.GameObjects.GameObject) {
        child.once(Phaser.GameObjects.Events.DESTROY, () => container.remove(child as any));
      }
    }
  };
  proto.add = function (this: MockContainer, obj) {
    listen(this, obj);
    return add.call(this, obj);
  };
  proto.addAt = function (this: MockContainer, obj, index) {
    listen(this, obj);
    return addAt.call(this, obj, index);
  };
  proto[MOCK_ADD] = true;
}

/** Replace Math.random with a generator seeded from `seed` until the test ends (vitest's restoreMocks). */
export function seedMathRandom(seed: string): void {
  const rng = new Phaser.Math.RandomDataGenerator([`math:${seed}`]);
  vi.spyOn(Math, "random").mockImplementation(() => rng.frac());
}

/**
 * Boot a Classic run of the real game with `speciesIds` as starters and its RNG (and Math.random) seeded
 * from `seed`. Stops after wave 1's EncounterPhase ends, like `classicMode.runToSummon()`, so a Driver
 * can take over.
 */
export async function startClassicRun(
  game: GameManager,
  seed: string,
  ...speciesIds: SpeciesId[]
): Promise<void> {
  restoreRealGame();
  seedMathRandom(seed);
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
