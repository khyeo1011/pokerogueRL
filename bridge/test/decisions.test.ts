// One test per decision kind (issue #7): force the decision with the harness's overrides, answer it
// through the driver, and check the game did what the action asked. Boots through the harness
// (classicMode.runToSummon: max rolls, mystery encounters off), whose determinism keeps these focused.
// Run with scripts/test_bridge.sh decisions.

import { BattleStyle } from "#enums/battle-style";
import { BattleType } from "#enums/battle-type";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Driver } from "../driver";
import { nextDecision, playUntil } from "./play";

const FOUR_MOVES = [MoveId.TACKLE, MoveId.GROWL, MoveId.SCRATCH, MoveId.LEER];

describe("Driver decisions", { timeout: 60_000 }, () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.enemySpecies(SpeciesId.MAGIKARP).enemyMoveset(MoveId.SPLASH).enemyLevel(5).startingLevel(10);
  });

  async function boot(...species: SpeciesId[]): Promise<Driver> {
    await game.classicMode.runToSummon(...(species as [SpeciesId]));
    return new Driver(game);
  }

  describe("command", () => {
    it("lists moves, switches, balls and run in a wild battle", async () => {
      game.override.moveset([MoveId.TACKLE, MoveId.GROWL]);
      const driver = await boot(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE);
      const decision = await playUntil(game, driver, "command");

      expect(decision.fieldIndex).toBe(0);
      expect(decision.legal).toEqual(
        expect.arrayContaining([
          { kind: "move", slot: 0 },
          { kind: "move", slot: 1 },
          { kind: "switch", partySlot: 1 },
          { kind: "ball", ball: PokeballType.POKEBALL },
          { kind: "run" },
        ]),
      );
      expect(decision.legal).not.toContainEqual({ kind: "switch", partySlot: 0 });
      expect(() => driver.act({ kind: "switch", partySlot: 0 })).toThrow(/Illegal action/);
      expect(() => driver.act({ kind: "move", slot: 2 })).toThrow(/Illegal action/);
      expect(() => driver.act({ kind: "skipReward" })).toThrow(/Illegal action/);
    });

    it("has no balls or run in a trainer battle", async () => {
      game.override.moveset([MoveId.TACKLE]).battleType(BattleType.TRAINER);
      const driver = await boot(SpeciesId.CHARMANDER);
      const decision = await playUntil(game, driver, "command");
      expect(decision.legal).toEqual([{ kind: "move", slot: 0 }]);
    });

    it("switches out on a switch command", async () => {
      game.override.moveset([MoveId.TACKLE]);
      const driver = await boot(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE);
      await playUntil(game, driver, "command");
      driver.act({ kind: "switch", partySlot: 1 });
      await playUntil(game, driver, "command");
      expect(game.scene.getPlayerField()[0].species.speciesId).toBe(SpeciesId.SQUIRTLE);
    });

    it("catches with a ball", async () => {
      game.override.moveset([MoveId.TACKLE]);
      const driver = await boot(SpeciesId.CHARMANDER);
      game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 1;
      await playUntil(game, driver, "command");
      driver.act({ kind: "ball", ball: PokeballType.MASTER_BALL });
      await playUntil(game, driver, "reward");
      expect(game.scene.getPlayerParty().map(p => p.species.speciesId)).toEqual([
        SpeciesId.CHARMANDER,
        SpeciesId.MAGIKARP,
      ]);
    });
  });

  it("target: picks the target of a single-target move in doubles", async () => {
    game.override.moveset([MoveId.TACKLE, MoveId.SURF]).battleStyle("double");
    const driver = await boot(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE);
    const command = await playUntil(game, driver, "command");
    driver.act({ kind: "move", slot: 0 });
    const target = await nextDecision(game, driver);
    expect(target.kind).toBe("target");
    expect(target.legal).toEqual(
      expect.arrayContaining([
        { kind: "target", target: BattlerIndex.ENEMY },
        { kind: "target", target: BattlerIndex.ENEMY_2 },
      ]),
    );
    driver.act({ kind: "target", target: BattlerIndex.ENEMY_2 });
    expect(game.scene.currentBattle.turnCommands[command.fieldIndex]?.targets).toEqual([BattlerIndex.ENEMY_2]);

    // Surf hits both enemies and the ally: no target decision, the next one is the second Pokémon's command.
    const second = await nextDecision(game, driver);
    expect(second).toMatchObject({ kind: "command", fieldIndex: 1 });
    driver.act({ kind: "move", slot: 1 });
    expect((await nextDecision(game, driver)).kind).not.toBe("target");
  });

  it("switch: sends in a replacement after a faint", async () => {
    game.override.moveset([MoveId.SPLASH]).enemyMoveset(MoveId.TACKLE).enemyLevel(100);
    const driver = await boot(SpeciesId.MAGIKARP, SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE);
    const decision = await playUntil(game, driver, "switch");
    expect(decision.legal).toEqual([
      { kind: "switch", partySlot: 1 },
      { kind: "switch", partySlot: 2 },
    ]);
    driver.act({ kind: "switch", partySlot: 2 });
    await playUntil(game, driver, "command");
    expect(game.scene.getPlayerField()[0].species.speciesId).toBe(SpeciesId.SQUIRTLE);
  });

  it("checkSwitch: switches at the start of a wave in the Switch battle style", async () => {
    game.override.moveset([MoveId.TACKLE]);
    game.settings.battleStyle(BattleStyle.SWITCH);
    const driver = await boot(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE);
    const decision = await nextDecision(game, driver);
    expect(decision).toEqual({
      kind: "checkSwitch",
      fieldIndex: 0,
      legal: [{ kind: "stay" }, { kind: "switch", partySlot: 1 }],
    });
    driver.act({ kind: "switch", partySlot: 1 });
    await playUntil(game, driver, "command");
    expect(game.scene.getPlayerField()[0].species.speciesId).toBe(SpeciesId.SQUIRTLE);
  });

  describe("reward", () => {
    it("takes a reward that needs a move: Ether", async () => {
      game.override.moveset([MoveId.TACKLE, MoveId.GROWL]).itemRewards([{ name: "ETHER" }]);
      const driver = await boot(SpeciesId.CHARMANDER);
      const reward = await playUntil(game, driver, "reward");
      expect(reward.rewards[0]).toBe("ETHER");
      driver.act({ kind: "reward", index: 0 });
      const target = await nextDecision(game, driver);
      // Only Tackle has used PP.
      expect(target).toEqual({
        kind: "itemTarget",
        item: "ETHER",
        legal: [{ kind: "itemTarget", partySlot: 0, move: 0 }],
      });
      driver.act({ kind: "itemTarget", partySlot: 0, move: 0 });
      await playUntil(game, driver, "command");
      expect(game.scene.getPlayerPokemon()!.getMoveset()[0].ppUsed).toBe(0);
    });

    it("teaches a TM, through the learn-move prompt when the moveset is full", async () => {
      game.override.itemRewards([{ name: "TM_COMMON", type: MoveId.FLAMETHROWER }]);
      const driver = await boot(SpeciesId.CHARMANDER);
      // Not the moveset override: getMoveset() would keep returning it after the move is learned.
      game.move.changeMoveset(game.scene.getPlayerParty()[0], FOUR_MOVES);
      await playUntil(game, driver, "reward");
      driver.act({ kind: "reward", index: 0 });
      const target = await nextDecision(game, driver);
      expect(target).toMatchObject({ kind: "itemTarget", legal: [{ kind: "itemTarget", partySlot: 0 }] });
      driver.act({ kind: "itemTarget", partySlot: 0 });
      const learn = await nextDecision(game, driver);
      expect(learn).toMatchObject({ kind: "learnMove", partySlot: 0, moveId: MoveId.FLAMETHROWER });
      driver.act({ kind: "learnMove", forget: 1 });
      await playUntil(game, driver, "command");
      expect(game.scene.getPlayerPokemon()!.getMoveset().map(m => m.moveId)).toEqual([
        MoveId.TACKLE,
        MoveId.FLAMETHROWER,
        MoveId.SCRATCH,
        MoveId.LEER,
      ]);
    });

    it("rerolls, buys from the shop and skips", async () => {
      game.override.moveset([MoveId.TACKLE]).itemRewards([{ name: "ETHER" }]);
      const driver = await boot(SpeciesId.CHARMANDER);
      game.scene.money = 100_000;
      const first = await playUntil(game, driver, "reward");
      expect(first.legal).toContainEqual({ kind: "reroll" });
      driver.act({ kind: "reroll" });

      const second = await nextDecision(game, driver);
      expect(second.kind).toBe("reward");
      if (second.kind !== "reward") {
        return;
      }
      expect(second.money).toBe(100_000 - first.rerollCost);
      const ether = second.shop.findIndex(s => s.item === "ETHER");
      expect(second.legal).toContainEqual({ kind: "buy", index: ether });
      driver.act({ kind: "buy", index: ether });
      const target = await nextDecision(game, driver);
      expect(target).toMatchObject({ kind: "itemTarget", item: "ETHER" });
      driver.act(target.legal[0]);

      // The shop stays open after a purchase.
      const third = await nextDecision(game, driver);
      expect(third).toMatchObject({ kind: "reward", money: second.money - second.shop[ether].cost });
      driver.act({ kind: "skipReward" });
      const next = await nextDecision(game, driver);
      expect(game.scene.currentBattle.waveIndex).toBe(2);
      expect(next.kind).toBe("command");
    });
  });

  describe("learnMove", () => {
    beforeEach(() => {
      game.override.startingLevel(5).xpMultiplier(50);
    });

    async function bootBulbasaur(): Promise<Driver> {
      const driver = await boot(SpeciesId.BULBASAUR);
      game.move.changeMoveset(game.scene.getPlayerParty()[0], FOUR_MOVES);
      return driver;
    }

    it("replaces the chosen move", async () => {
      const driver = await bootBulbasaur();
      const decision = await playUntil(game, driver, "learnMove");
      expect(decision.legal).toHaveLength(5);
      driver.act({ kind: "learnMove", forget: 3 });
      await nextDecision(game, driver);
      const moves = game.scene.getPlayerParty()[0].getMoveset().map(m => m.moveId);
      expect(moves).toEqual([MoveId.TACKLE, MoveId.GROWL, MoveId.SCRATCH, decision.moveId]);
    });

    it("keeps the moveset on skipMove", async () => {
      const driver = await bootBulbasaur();
      await playUntil(game, driver, "learnMove");
      driver.act({ kind: "skipMove" });
      await nextDecision(game, driver);
      const moves = game.scene.getPlayerParty()[0].getMoveset().map(m => m.moveId);
      expect(moves).toEqual([MoveId.TACKLE, MoveId.GROWL, MoveId.SCRATCH, MoveId.LEER]);
    });
  });

  it("biome: chooses the next biome with a Map", async () => {
    game.override
      .moveset([MoveId.TACKLE])
      .startingModifier([{ name: "MAP" }])
      .startingBiome(BiomeId.PLAINS)
      .startingWave(10)
      .battleType(BattleType.WILD)
      .enemyHealthSegments(1);
    const driver = await boot(SpeciesId.CHARMANDER);
    const decision = await playUntil(game, driver, "biome");
    expect(decision.biomes.length).toBeGreaterThan(1);
    const biome = decision.biomes.at(-1)!;
    driver.act({ kind: "biome", biome });
    await playUntil(game, driver, "command");
    expect(game.scene.arena.biomeId).toBe(biome);
  });

  describe("evolution", () => {
    beforeEach(() => {
      game.override.moveset([MoveId.TACKLE]).startingLevel(15).xpMultiplier(10);
    });

    it("evolves", async () => {
      const driver = await boot(SpeciesId.CHARMANDER);
      const decision = await playUntil(game, driver, "evolution");
      expect(decision).toMatchObject({ partySlot: 0, speciesId: SpeciesId.CHARMELEON });
      driver.act({ kind: "evolve" });
      await nextDecision(game, driver);
      expect(game.scene.getPlayerParty()[0].species.speciesId).toBe(SpeciesId.CHARMELEON);
    });

    it("cancels", async () => {
      const driver = await boot(SpeciesId.CHARMANDER);
      await playUntil(game, driver, "evolution");
      driver.act({ kind: "cancelEvolution" });
      await nextDecision(game, driver);
      const pokemon = game.scene.getPlayerParty()[0];
      expect(pokemon.species.speciesId).toBe(SpeciesId.CHARMANDER);
      expect(pokemon.pauseEvolutions).toBeFalsy();
    });
  });

  describe("partyFull", () => {
    const SIX = [
      SpeciesId.CHARMANDER,
      SpeciesId.SQUIRTLE,
      SpeciesId.BULBASAUR,
      SpeciesId.PIDGEY,
      SpeciesId.RATTATA,
      SpeciesId.CATERPIE,
    ];

    async function catchWithFullParty(): Promise<Driver> {
      game.override.moveset([MoveId.TACKLE]);
      const driver = await boot(...SIX);
      game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 1;
      await playUntil(game, driver, "command");
      driver.act({ kind: "ball", ball: PokeballType.MASTER_BALL });
      const decision = await nextDecision(game, driver);
      expect(decision).toMatchObject({ kind: "partyFull", speciesId: SpeciesId.MAGIKARP });
      expect(decision.legal).toHaveLength(7);
      return driver;
    }

    it("releases a party member to keep the caught Pokémon", async () => {
      const driver = await catchWithFullParty();
      driver.act({ kind: "release", partySlot: 3 });
      await playUntil(game, driver, "reward");
      const party = game.scene.getPlayerParty().map(p => p.species.speciesId);
      expect(party).toHaveLength(6);
      expect(party).not.toContain(SpeciesId.PIDGEY);
      expect(party).toContain(SpeciesId.MAGIKARP);
    });

    it("lets the caught Pokémon go", async () => {
      const driver = await catchWithFullParty();
      driver.act({ kind: "keepParty" });
      await playUntil(game, driver, "reward");
      expect(game.scene.getPlayerParty().map(p => p.species.speciesId)).toEqual(SIX);
    });
  });

  it("revive: revives a fainted party member with Revival Blessing", async () => {
    game.override.moveset([MoveId.REVIVAL_BLESSING]);
    const driver = await boot(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
    const fainted = game.scene.getPlayerParty()[2];
    fainted.hp = 0;
    fainted.doSetStatus(StatusEffect.FAINT);
    await playUntil(game, driver, "command");
    driver.act({ kind: "move", slot: 0 });
    const decision = await nextDecision(game, driver);
    expect(decision).toEqual({ kind: "revive", legal: [{ kind: "revive", partySlot: 2 }] });
    driver.act({ kind: "revive", partySlot: 2 });
    await nextDecision(game, driver);
    expect(fainted.isFainted()).toBe(false);
  });

  it("gameOver: ends the run when the party wipes", async () => {
    game.override.moveset([MoveId.SPLASH]).enemyMoveset(MoveId.TACKLE).enemyLevel(100);
    const driver = await boot(SpeciesId.MAGIKARP);
    const decision = await playUntil(game, driver, "gameOver");
    expect(decision).toEqual({ kind: "gameOver", victory: false, legal: [] });
    expect(() => driver.act({ kind: "run" })).toThrow(/no pending decision/);
  });
});
