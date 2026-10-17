// Checks bridge/observation.ts: every stage's observation is plain JSON with only the fields a player can
// see (ALLOWED_PATHS in observation-helpers.ts), and the reveal tracker only shows what the game revealed.
// Observations come from real runs through the driver (Driver.observe()), played by the default policy.
// Stages that rarely come up early in a run, and mystery encounters (bridge/test/mystery-encounters.test.ts
// checks those through the driver), are also built from real game state with the inputs the driver passes.
// Run with scripts/test_bridge.sh.

import { modifierTypes } from "#data/data-lists";
import { AbilityId } from "#enums/ability-id";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Driver } from "../driver";
import { buildObservation, type Observation, type StageInput } from "../observation";
import { defaultPolicy } from "../policy";
import { RevealTracker } from "../reveal-tracker";
import { startClassicRun } from "../run";
import { exportStaticData } from "../static-data";
import { disallowedPaths } from "./observation-helpers";

const STARTERS = [SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR];

/** Assert `obs` is plain JSON with only allowed fields. */
function expectFair(obs: Observation): void {
  expect(disallowedPaths(obs)).toEqual([]);
  expect(JSON.parse(JSON.stringify(obs))).toEqual(obs);
  for (const enemy of obs.battle.enemies) {
    const width = enemy.bossSegments > 0 ? 86 : 48;
    expect(Number.isInteger(Math.round(enemy.hp * width * 1e6) / 1e6)).toBe(true);
  }
}

describe("buildObservation", () => {
  let phaserGame: Phaser.Game;
  let driver: Driver | undefined;
  let tracker: RevealTracker | undefined;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    driver?.dispose();
    driver = undefined;
    tracker?.dispose();
    tracker = undefined;
  });

  /** Boot a real run and attach a driver (which tracks reveals), as the bridge will. */
  async function boot(seed: string, species = STARTERS) {
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...species);
    driver = new Driver(game);
    return { game, scene: game.scene, tracker: driver.tracker, driver };
  }

  it("shows only visible fields at every decision of a real run", { timeout: 60_000 }, async () => {
    const { scene, driver } = await boot("obs-run");
    const kinds = new Set<string>();
    for (;;) {
      const decision = await driver.next();
      if (decision.kind === "gameOver" || scene.currentBattle.waveIndex > 5 || driver.turns > 100) {
        break;
      }
      const obs = driver.observe();
      expectFair(obs);
      // The partyFull decision's stage is the caught Pokémon.
      expect(obs.stage.kind).toBe(decision.kind === "partyFull" ? "catch" : decision.kind);
      kinds.add(decision.kind);
      driver.act(defaultPolicy(obs, decision.legal));
    }
    console.info(`stages seen: ${[...kinds].join(", ")}`);
    expect(kinds).toContain("command");
    expect(kinds).toContain("reward");
  });

  it("shows a switch after a faint, with the enemy's revealed moves", { timeout: 60_000 }, async () => {
    const game = new GameManager(phaserGame);
    game.override.enemyLevel(40);
    await startClassicRun(game, "obs-switch", ...STARTERS);
    const scene = game.scene;
    driver = new Driver(game);

    let switchObs: Observation | undefined;
    while (switchObs == null) {
      const decision = await driver.next();
      expect(decision.kind).not.toBe("gameOver");
      if (decision.kind === "gameOver") {
        return;
      }
      const obs = driver.observe();
      expectFair(obs);
      if (decision.kind === "switch") {
        switchObs = obs;
      } else {
        driver.act(defaultPolicy(obs, decision.legal));
      }
    }

    expect(switchObs.party[0].hp).toBe(0);
    const enemy = scene.getEnemyField()[0];
    const [shown] = switchObs.battle.enemies;
    expect(shown.speciesId).toBe(enemy.species.speciesId);
    expect(shown.level).toBe(40);
    // It knocked out the lead, so it used at least one move, and only moves it has.
    expect(shown.revealedMoves.length).toBeGreaterThan(0);
    const moveset = enemy.getMoveset().map(m => m.moveId);
    for (const m of shown.revealedMoves) {
      expect(moveset).toContain(m.moveId);
    }
  });

  it("reveals an ability shown by a popup and keeps a passive popup apart", { timeout: 60_000 }, async () => {
    const game = new GameManager(phaserGame);
    game.override
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyPassiveAbility(AbilityId.DROUGHT)
      .enemyHasPassiveAbility(true)
      .ability(AbilityId.INTIMIDATE);
    await startClassicRun(game, "obs-ability", ...STARTERS);
    driver = new Driver(game);
    const decision = await driver.next();
    expect(decision.kind).toBe("command");
    const obs = driver.observe();
    expectFair(obs);

    // Drought's popup shows the passive; Ball Fetch never triggered, so the ability stays hidden.
    const [enemy] = obs.battle.enemies;
    expect(enemy.revealedPassiveId).toBe(AbilityId.DROUGHT);
    expect(enemy.revealedAbilityId).toBeNull();
    expect(obs.battle.weather?.type).toBeGreaterThan(0);
    // Intimidate lowered the enemy's Attack, which its stat box shows.
    expect(enemy.field.statStages[0]).toBeLessThan(0);
  });

  it("reveals an enemy ability named by Frisk", { timeout: 60_000 }, async () => {
    const game = new GameManager(phaserGame);
    game.override.ability(AbilityId.FRISK).enemyAbility(AbilityId.BALL_FETCH).enemyHasPassiveAbility(false);
    await startClassicRun(game, "obs-frisk", ...STARTERS);
    driver = new Driver(game);
    await driver.next();
    const obs = driver.observe();
    expect(obs.battle.enemies[0].revealedAbilityId).toBe(AbilityId.BALL_FETCH);
  });

  it("builds the stages that come up rarely from real state", { timeout: 60_000 }, async () => {
    const { scene, tracker, driver } = await boot("obs-full-party", [
      ...STARTERS,
      SpeciesId.PIKACHU,
      SpeciesId.EEVEE,
      SpeciesId.MACHOP,
    ]);
    await driver.next();
    const inputs: StageInput[] = [
      { kind: "learnMove", partySlot: 1, moveId: MoveId.SURF },
      { kind: "biome", choices: [BiomeId.FOREST, BiomeId.CAVE] },
      { kind: "catch", pokemon: scene.getEnemyField()[0] },
      { kind: "checkSwitch", fieldIndex: 0 },
      { kind: "itemTarget", type: modifierTypes.POTION() },
      { kind: "evolution", partySlot: 0, speciesId: SpeciesId.CHARMELEON },
      { kind: "revive" },
    ];
    for (const input of inputs) {
      const obs = buildObservation(scene, tracker, input);
      expectFair(obs);
      expect(obs.stage.kind).toBe(input.kind);
      expect(obs.party).toHaveLength(6);
    }
    expect(buildObservation(scene, tracker, inputs[4]).stage).toEqual({
      kind: "itemTarget",
      item: { id: "POTION", args: [] },
    });
    // The caught Pokémon's summary can be opened, so its full data is shown, unlike in battle.
    const caught = buildObservation(scene, tracker, inputs[2]);
    const enemy = scene.getEnemyField()[0];
    expect(caught.stage.kind === "catch" && caught.stage.pokemon.ivs).toEqual(enemy.ivs);
  });

  it("builds a mystery encounter stage", { timeout: 60_000 }, async () => {
    const game = new GameManager(phaserGame);
    game.override.mysteryEncounterChance(100).startingWave(12).startingBiome(BiomeId.CAVE);
    await game.runToMysteryEncounter(MysteryEncounterType.FIGHT_OR_FLIGHT, STARTERS);
    const scene = game.scene;
    tracker = new RevealTracker(scene);
    // What MysteryEncounterUiHandler computes when it shows the options.
    const options = scene.currentBattle.mysteryEncounter!.options;
    const optionsMeetsReqs = options.map(o => o.meetsRequirements());
    const obs = buildObservation(scene, tracker, { kind: "mysteryEncounter", options, optionsMeetsReqs, followUp: false });
    expectFair(obs);
    expect(obs.stage).toMatchObject({
      kind: "mysteryEncounter",
      encounterType: MysteryEncounterType.FIGHT_OR_FLIGHT,
      followUp: false,
      options: optionsMeetsReqs.map(() => ({
        label: expect.any(String),
        tooltip: expect.any(String),
        disabled: expect.any(Boolean),
        special: expect.any(Boolean),
      })),
    });
    for (const input of [
      { kind: "mePokemon", option: 0 },
      { kind: "meSubOption", option: 0, labels: ["Yes", "No"] },
    ] as const) {
      const sub = buildObservation(scene, tracker, input);
      expectFair(sub);
      expect(sub.stage).toMatchObject({ ...input, encounterType: MysteryEncounterType.FIGHT_OR_FLIGHT });
    }
  });
});

describe("exportStaticData", () => {
  it("exports species, moves and the type chart as plain JSON", () => {
    const data = exportStaticData();
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data.species.length).toBeGreaterThan(1000);
    expect(data.moves.length).toBeGreaterThan(900);
    expect(data.typeChart).toHaveLength(18);
    // Fire (9) is super effective on Grass (11); Normal (0) does nothing to Ghost (7).
    expect(data.typeChart[9][11]).toBe(2);
    expect(data.typeChart[0][7]).toBe(0);
    // Policies index the moves table by move ID.
    expect(data.moves.every((m, i) => m.moveId === i)).toBe(true);
    const bulbasaur = data.species.find(s => s.speciesId === SpeciesId.BULBASAUR)!;
    expect(bulbasaur.forms[0].baseStats).toEqual([45, 49, 49, 65, 65, 45]);
  });
});
