// Checks that startClassicRun() (bridge/run.ts) boots the real game: each harness change listed in
// issue #3 is undone, and the run's RNG comes from its seed. A whole run replays from its seed, also past
// wave 35 where upstream draws from Math.random (issue #9). Run with scripts/test_bridge.sh.

import { activeOverrides, defaultOverrides } from "#app/overrides";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Driver } from "../driver";
import { defaultPolicy } from "../policy";
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

  // Starters at level 100 reach the evil-team waves (35, 62, 64, 66), whose trainers use Math.random.
  describe("replay", () => {
    /** Per run: every decision with its legal actions and the action taken, and the final party. */
    const runs: { trace: string[]; party: string[] }[] = [];

    it.each([1, 2])("plays the same run from the same seed (%i)", { timeout: 120_000 }, async () => {
      const game = new GameManager(phaserGame);
      game.override.startingLevel(100);
      await startClassicRun(game, "replay", ...STARTERS);
      const driver = new Driver(game);
      const trace: string[] = [];
      for (;;) {
        const decision = await driver.next();
        trace.push(`${game.scene.currentBattle.waveIndex} ${JSON.stringify(decision)}`);
        expect(decision.kind).not.toBe("truncated");
        if (decision.kind === "gameOver" || decision.kind === "truncated") {
          break;
        }
        const action = defaultPolicy(driver.observe(), decision.legal);
        trace.push(JSON.stringify(action));
        driver.act(action);
      }
      driver.dispose();
      const party = game.scene.getPlayerParty().map(p => `${p.species.speciesId} L${p.level} ${p.hp}/${p.getMaxHp()}`);
      runs.push({ trace, party });
    });

    // (The number of phases can differ by one: some phases are queued from timers.)
    it("got past wave 35 the same way twice", () => {
      expect(runs).toHaveLength(2);
      expect(Number.parseInt(runs[0].trace.at(-1)!)).toBeGreaterThan(35);
      expect(runs[1].trace).toEqual(runs[0].trace);
      expect(runs[1].party).toEqual(runs[0].party);
    });
  });
});
