// Every mystery encounter type, forced on the real game (startClassicRun) and played through the driver
// (issue #8): the wave before is a normal wild battle, then the encounter. One test per encounter answers
// its menu with the default policy, and one per option picks that option instead (when the menu allows
// it). Everything after uses the default policy until the next wave starts or the run ends.
// Then the flows around encounters: gift Pokémon with a full party, surviving a lost battle, eggs.
// Run with scripts/test_bridge.sh mystery-encounters.

import { activeOverrides } from "#app/overrides";
import { Egg } from "#data/egg";
import { BerryType } from "#enums/berry-type";
import { BiomeId } from "#enums/biome-id";
import { EggSourceType } from "#enums/egg-source-types";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import type { ModifierOverride } from "#modifiers/modifier-type";
import { GameManager } from "#test/framework/game-manager";
import type { MockText } from "#test/mocks/mocks-container/mock-text";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Decision, Driver } from "../driver";
import { defaultAction } from "../policy";
import { startClassicRun } from "../run";
import { nextDecision, playUntil } from "./play";

const PARTY = [SpeciesId.LAPRAS, SpeciesId.GENGAR, SpeciesId.ABRA];

/**
 * Per encounter: its number of options, the wave it appears on (in its range) and the biome. Some get a
 * party, moves or held items (on the lead) that unlock options with requirements.
 */
interface Case {
  type: MysteryEncounterType;
  options: number;
  wave: number;
  biome: BiomeId;
  party?: SpeciesId[];
  moves?: MoveId[];
  held?: ModifierOverride[];
}

// Waves end in 2. The run starts on the wave before, which ends in 1, so no encounter can spawn there
// (startClassicRun restores the real encounter rate before the first wave).
const CASES: Case[] = [
  { type: MysteryEncounterType.MYSTERIOUS_CHALLENGERS, options: 3, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.MYSTERIOUS_CHEST, options: 2, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.DARK_DEAL, options: 2, wave: 42, biome: BiomeId.CAVE },
  {
    type: MysteryEncounterType.FIGHT_OR_FLIGHT,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    moves: [MoveId.SURF, MoveId.KNOCK_OFF],
  },
  {
    type: MysteryEncounterType.SLUMBERING_SNORLAX,
    options: 3,
    wave: 42,
    biome: BiomeId.PLAINS,
    moves: [MoveId.SURF, MoveId.KNOCK_OFF],
  },
  { type: MysteryEncounterType.TRAINING_SESSION, options: 4, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.DEPARTMENT_STORE_SALE, options: 4, wave: 42, biome: BiomeId.PLAINS },
  { type: MysteryEncounterType.SHADY_VITAMIN_DEALER, options: 3, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.FIELD_TRIP, options: 3, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.SAFARI_ZONE, options: 2, wave: 42, biome: BiomeId.SWAMP },
  {
    type: MysteryEncounterType.LOST_AT_SEA,
    options: 3,
    wave: 32,
    biome: BiomeId.SEA,
    party: [SpeciesId.BLASTOISE, SpeciesId.PIDGEOT, SpeciesId.ABRA],
  },
  {
    type: MysteryEncounterType.FIERY_FALLOUT,
    options: 3,
    wave: 52,
    biome: BiomeId.VOLCANO,
    party: [SpeciesId.ARCANINE, ...PARTY],
  },
  { type: MysteryEncounterType.THE_STRONG_STUFF, options: 2, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.THE_POKEMON_SALESMAN, options: 2, wave: 42, biome: BiomeId.CAVE },
  {
    type: MysteryEncounterType.AN_OFFER_YOU_CANT_REFUSE,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    moves: [MoveId.SURF, MoveId.WRAP],
  },
  {
    type: MysteryEncounterType.DELIBIRDY,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    held: [{ name: "BERRY", count: 2, type: BerryType.SITRUS }, { name: "LEFTOVERS" }],
  },
  { type: MysteryEncounterType.ABSOLUTE_AVARICE, options: 3, wave: 42, biome: BiomeId.TALL_GRASS },
  { type: MysteryEncounterType.A_TRAINERS_TEST, options: 2, wave: 102, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.TRASH_TO_TREASURE, options: 2, wave: 102, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.BERRIES_ABOUND, options: 3, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.CLOWNING_AROUND, options: 3, wave: 82, biome: BiomeId.CAVE },
  {
    type: MysteryEncounterType.PART_TIMER,
    options: 3,
    wave: 42,
    biome: BiomeId.PLAINS,
    moves: [MoveId.SURF, MoveId.CHARM],
  },
  {
    type: MysteryEncounterType.DANCING_LESSONS,
    options: 3,
    wave: 42,
    biome: BiomeId.PLAINS,
    moves: [MoveId.SURF, MoveId.SWORDS_DANCE],
  },
  { type: MysteryEncounterType.WEIRD_DREAM, options: 3, wave: 42, biome: BiomeId.CAVE },
  { type: MysteryEncounterType.THE_WINSTRATE_CHALLENGE, options: 2, wave: 102, biome: BiomeId.CAVE },
  {
    type: MysteryEncounterType.TELEPORTING_HIJINKS,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    party: [...PARTY, SpeciesId.MAGNEZONE],
  },
  {
    type: MysteryEncounterType.BUG_TYPE_SUPERFAN,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    party: [...PARTY, SpeciesId.SCIZOR],
    held: [{ name: "QUICK_CLAW" }],
  },
  { type: MysteryEncounterType.FUN_AND_GAMES, options: 2, wave: 42, biome: BiomeId.PLAINS },
  {
    type: MysteryEncounterType.UNCOMMON_BREED,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    moves: [MoveId.SURF, MoveId.CHARM],
    held: [{ name: "BERRY", count: 4, type: BerryType.SITRUS }],
  },
  { type: MysteryEncounterType.GLOBAL_TRADE_SYSTEM, options: 4, wave: 42, biome: BiomeId.PLAINS },
  {
    type: MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER,
    options: 3,
    wave: 42,
    biome: BiomeId.CAVE,
    party: [...PARTY, SpeciesId.MAGIKARP],
  },
];

/** One row per encounter with the default policy (option -1), then one per option. */
const ROWS = CASES.flatMap(c =>
  [-1, ...Array.from({ length: c.options }, (_, i) => i)].map(option => ({
    ...c,
    name: MysteryEncounterType[c.type],
    option,
    label: option < 0 ? "default policy" : `option ${option + 1}`,
  })),
);

/**
 * The decision shows what the screen shows: the option labels as drawn by the encounter menu, no unfilled
 * tokens or markup, and greyed-out options are not legal.
 */
function checkShownAsOnScreen(game: GameManager, decision: Extract<Decision, { kind: "mysteryEncounter" }>): void {
  const handler = game.scene.ui.getHandler() as MysteryEncounterUiHandler;
  const drawn = (handler["optionsContainer"].getAll() as unknown as MockText[]).slice(0, -1); // the last is "View Party"
  expect(drawn.map(t => t.text.replace(/\[\/?(color|shadow)[^\]]*\]/g, ""))).toEqual(
    decision.options.map(o => o.label),
  );
  expect(JSON.stringify(decision)).not.toMatch(/\{\{|@\[|@d\{/);
  for (const [index, option] of decision.options.entries()) {
    expect(decision.legal.some(a => a.index === index)).toBe(!option.disabled);
  }
}

/** Boot a run on the wave before `wave` and force encounter `type` on `wave`. */
async function bootBefore(
  game: GameManager,
  seed: string,
  type: MysteryEncounterType,
  { wave, biome, party, moves, held }: Omit<Case, "type" | "options">,
): Promise<Driver> {
  game.override
    .startingWave(wave - 1)
    .startingBiome(biome)
    .startingLevel(100)
    .disableTrainerWaves();
  if (moves) {
    game.override.moveset(moves);
  }
  if (held) {
    game.override.startingHeldItems(held);
  }
  await startClassicRun(game, seed, ...(party ?? PARTY));
  game.override.mysteryEncounterChance(100).mysteryEncounter(type);
  game.scene.money = 100_000;
  return new Driver(game);
}

describe("Mystery encounters through the driver", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it.each(ROWS)("$name, $label", { timeout: 120_000 }, async ({ type, options, option, name, ...setup }) => {
    const game = new GameManager(phaserGame);
    const driver = await bootBefore(game, `me-${name}-${option}`, type, setup);

    const seen: string[] = [];
    let decision: Decision;
    let picked = false;
    for (;;) {
      decision = await nextDecision(game, driver);
      seen.push(decision.kind);
      if (decision.kind === "gameOver" || game.scene.currentBattle.waveIndex > setup.wave) {
        break;
      }
      if (decision.kind === "mysteryEncounter" && !decision.followUp && !picked) {
        picked = true;
        game.override.mysteryEncounterChance(0);
        expect(decision.encounterType).toBe(type);
        expect(decision.options).toHaveLength(options);
        expect(game.scene.currentBattle.waveIndex).toBe(setup.wave);
        checkShownAsOnScreen(game, decision);
        if (option >= 0) {
          const action = decision.legal.find(a => a.index === option);
          expect(action, `option ${option + 1} is legal`).toBeDefined();
          driver.act(action!);
          continue;
        }
        console.info(JSON.stringify(decision));
      }
      driver.act(defaultAction(game.scene, decision));
    }

    expect(picked).toBe(true);
    const end = decision.kind === "gameOver" ? "game over" : `wave ${game.scene.currentBattle.waveIndex}`;
    console.info(`${name} (${option < 0 ? "default" : `option ${option + 1}`}): ${end}; ${seen.join(" ")}`);
  });
});

describe("Mystery encounter edge cases", { timeout: 120_000 }, () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  /** Default policy until the wave after `wave` asks for something; fails on game over before that. */
  async function playPastWave(driver: Driver, wave: number): Promise<Decision> {
    for (;;) {
      const decision = await nextDecision(game, driver);
      if (game.scene.currentBattle.waveIndex > wave) {
        return decision;
      }
      expect(decision.kind, `game over on wave ${wave}`).not.toBe("gameOver");
      driver.act(defaultAction(game.scene, decision as Exclude<Decision, { kind: "gameOver" }>));
    }
  }

  const FULL_PARTY = [...PARTY, SpeciesId.MAGIKARP, SpeciesId.PIDGEY, SpeciesId.RATTATA];

  it.each([
    { action: { kind: "release", partySlot: 5 }, kept: false },
    { action: { kind: "keepParty" }, kept: true },
  ] as const)("a Pokémon bought with a full party raises partyFull: $action.kind", async ({ action, kept }) => {
    game = new GameManager(phaserGame);
    const setup = { wave: 42, biome: BiomeId.CAVE, party: FULL_PARTY };
    const driver = await bootBefore(game, "me-party-full", MysteryEncounterType.THE_POKEMON_SALESMAN, setup);
    await playUntil(game, driver, "mysteryEncounter");
    game.override.mysteryEncounterChance(0);
    const before = game.scene.getPlayerParty().map(p => p.id);
    driver.act({ kind: "meOption", index: 0 });

    const decision = await playUntil(game, driver, "partyFull");
    expect(decision.legal).toContainEqual({ kind: "keepParty" });
    driver.act(action);
    await playPastWave(driver, 42);

    const party = game.scene.getPlayerParty();
    expect(party).toHaveLength(6);
    if (kept) {
      expect(party.map(p => p.id)).toEqual(before);
    } else {
      expect(party.map(p => p.id).slice(0, 5)).toEqual(before.slice(0, 5));
      expect(party[5].species.speciesId).toBe(decision.speciesId);
    }
  });

  it("an option whose requirements are not met is greyed out and not legal", async () => {
    game = new GameManager(phaserGame);
    const setup = { wave: 42, biome: BiomeId.CAVE };
    const driver = await bootBefore(game, "me-disabled", MysteryEncounterType.BUG_TYPE_SUPERFAN, setup);
    const decision = await playUntil(game, driver, "mysteryEncounter");
    // No Bug type in the party, no bug item: "Show Your Bug-types" and "Gift a Bug Item" are greyed out.
    expect(decision.options.map(o => o.disabled)).toEqual([false, true, true]);
    expect(decision.options[1].tooltip).toMatch(/You need at least 1 Bug-type/);
    expect(decision.legal).toEqual([{ kind: "meOption", index: 0 }]);
    expect(() => driver.act({ kind: "meOption", index: 1 })).toThrow(/Illegal action/);
  });

  it("a Pokémon pick that no Pokémon passes fails the run clearly", async () => {
    game = new GameManager(phaserGame);
    const held: ModifierOverride[] = [{ name: "BERRY", count: 2, type: BerryType.SITRUS }];
    const setup = { wave: 42, biome: BiomeId.CAVE, held };
    const driver = await bootBefore(game, "me-no-pick", MysteryEncounterType.DELIBIRDY, setup);
    await playUntil(game, driver, "mysteryEncounter");
    // "Give Food" was legal when the menu opened; without the berries its party screen has no valid Pokémon.
    for (const berry of game.scene.findModifiers(m => m.is("BerryModifier"))) {
      game.scene.removeModifier(berry);
    }
    driver.act({ kind: "meOption", index: 1 });
    await expect(nextDecision(game, driver)).rejects.toThrow(/mePokemon .* has no legal action/);
  });

  it("The Expert Pokémon Breeder: losing its battle does not end the run (onGameOver)", async () => {
    game = new GameManager(phaserGame);
    const setup = { wave: 42, biome: BiomeId.CAVE, party: [...PARTY, SpeciesId.MAGIKARP] };
    const driver = await bootBefore(game, "me-breeder-loss", MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER, setup);
    await playUntil(game, driver, "mysteryEncounter");
    // Lose: no damaging moves (the override replaces the first moves only, so all four), 1 HP each.
    game.override
      .mysteryEncounterChance(0)
      .moveset([MoveId.SPLASH, MoveId.CELEBRATE, MoveId.HOLD_HANDS, MoveId.HAPPY_HOUR])
      .enemyMoveset(MoveId.DARK_PULSE);
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.hp = 1;
    }
    const encounter = game.scene.currentBattle.mysteryEncounter!;
    driver.act({ kind: "meOption", index: 0 });

    await playPastWave(driver, 42);
    expect(encounter.misc.encounterFailed).toBe(true);
  });

  /** Two eggs ask "skip hatching?" (answered yes, then the summary closes); one hatches with its animation. */
  it.each([1, 2])("%i egg(s) ready to hatch after a wave", async count => {
    game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, "me-eggs", ...PARTY);
    for (let i = 0; i < count; i++) {
      new Egg({ species: SpeciesId.BULBASAUR, hatchWaves: 1, sourceType: EggSourceType.GACHA_MOVE }).addEggToGameData();
    }
    const driver = new Driver(game);
    await playPastWave(driver, 1);
    expect(game.scene.gameData.eggs).toHaveLength(0);
  });

  it("an egg from an encounter (A Trainer's Test) hatches", async () => {
    game = new GameManager(phaserGame);
    const driver = await bootBefore(game, "me-egg", MysteryEncounterType.A_TRAINERS_TEST, {
      wave: 102,
      biome: BiomeId.CAVE,
    });
    vi.spyOn(activeOverrides, "EGG_IMMEDIATE_HATCH_OVERRIDE", "get").mockReturnValue(true);
    const added = vi.spyOn(Egg.prototype, "addEggToGameData");
    await playUntil(game, driver, "mysteryEncounter");
    game.override.mysteryEncounterChance(0);
    driver.act({ kind: "meOption", index: 1 });
    await playPastWave(driver, 102);
    expect(added).toHaveBeenCalledTimes(1);
    expect(game.scene.gameData.eggs).toHaveLength(0);
  });
});
