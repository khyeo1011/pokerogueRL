// Checks that startClassicRun() (bridge/run.ts) boots the real game: each harness change listed in
// issue #3 is undone, and the run's RNG comes from its seed. Run with scripts/test_bridge.sh.

import { activeOverrides, defaultOverrides } from "#app/overrides";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { startClassicRun } from "../run";

const STARTERS = [SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR];

/** The overrides the harness sets: encounter rate 0, shinies off, IVs 31, Hardy natures. */
const HARNESS_OVERRIDES = [
  "MYSTERY_ENCOUNTER_RATE_OVERRIDE",
  "SHINY_OVERRIDE",
  "ENEMY_SHINY_OVERRIDE",
  "IVS_OVERRIDE",
  "ENEMY_IVS_OVERRIDE",
  "NATURE_OVERRIDE",
  "ENEMY_NATURE_OVERRIDE",
] as const;

/** The Pokémon a seed decides by the end of wave 1's EncounterPhase. */
function pokemonOf(game: GameManager) {
  return [...game.scene.getPlayerParty(), ...game.scene.getEnemyParty()].map(p => ({
    species: p.species.speciesId,
    ivs: p.ivs,
    nature: p.nature,
    shiny: p.shiny,
  }));
}

describe("startClassicRun", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it("undoes the harness's game changes", { timeout: 60_000 }, async () => {
    const game = new GameManager(phaserGame);
    const removeEnemyHeldItems = vi.spyOn(game, "removeEnemyHeldItems");
    await startClassicRun(game, "undo-test", ...STARTERS);
    const scene = game.scene;

    for (const key of HARNESS_OVERRIDES) {
      expect(activeOverrides[key], key).toBe(defaultOverrides[key]);
    }
    expect(removeEnemyHeldItems).not.toHaveBeenCalled();

    // The harness's max roll returns min + range - 1 (100 here) every time.
    const rolls = new Set(Array.from({ length: 50 }, () => scene.randBattleSeedInt(16, 85)));
    expect(rolls.size).toBeGreaterThan(1);

    const pokemon = pokemonOf(game);
    expect(pokemon.flatMap(p => p.ivs).some(iv => iv !== 31)).toBe(true);
    expect(pokemon.some(p => p.nature !== Nature.HARDY)).toBe(true);
  });

  // The harness supports one GameManager per test: it resets its mocks and prompt interval between tests.
  describe("seeding", () => {
    const runs: ReturnType<typeof pokemonOf>[] = [];

    it.each(["seed-a", "seed-a", "seed-b"])("boots run %# with seed %s", async seed => {
      const game = new GameManager(phaserGame);
      await startClassicRun(game, seed, ...STARTERS);
      expect(game.scene.seed).toBe(seed);
      runs.push(pokemonOf(game));
    });

    it("gives the same Pokémon for the same seed and different ones for another", () => {
      expect(runs).toHaveLength(3);
      expect(runs[1]).toEqual(runs[0]);
      expect(runs[2]).not.toEqual(runs[0]);
    });
  });
});
