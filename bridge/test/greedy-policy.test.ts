// Checks the greedy baseline policy (issue #14): its battle choices on built observations, then full real
// runs played to game over with only observations. Run with scripts/test_bridge.sh.

import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { PokemonType } from "#enums/pokemon-type";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../decisions";
import { Driver } from "../driver";
import type { EnemyPokemonObs, Observation, OwnPokemonObs, StageObs } from "../observation";
import { greedyPolicy } from "../policy";
import { startClassicRun } from "../run";
import { randomTeam } from "../team";
import { obs, snorlax, user } from "./built-observations";

let phaserGame: Phaser.Game;

beforeAll(() => {
  phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
});

/** A party member knowing `moves`, with full PP. */
const knowing = (moves: MoveId[], over: Partial<OwnPokemonObs> = {}) =>
  user({ moves: moves.map(moveId => ({ moveId, pp: 10, maxPp: 10 })), ...over });

/** The observation of `stage` with `party` and `enemies`. */
function battle(stage: StageObs, party: OwnPokemonObs[], enemies: EnemyPokemonObs[]): Observation {
  return { ...obs({ enemies, double: enemies.length > 1 }), stage, party };
}

const COMMAND: StageObs = { kind: "command", fieldIndex: 0 };
const moves = (n: number): Action[] => Array.from({ length: n }, (_, slot) => ({ kind: "move", slot }));

describe("greedyPolicy on built observations", () => {
  // The static data is exported from the game's tables, which need a scene.
  beforeAll(() => {
    new GameManager(phaserGame);
  });

  it("picks the move with the most estimated damage, not the most power", () => {
    const party = [knowing([MoveId.BODY_SLAM, MoveId.WATER_GUN], { types: [PokemonType.NORMAL] })];
    const ghost = snorlax({ types: [PokemonType.GHOST] });
    expect(greedyPolicy(battle(COMMAND, party, [ghost]), moves(2))).toEqual({ kind: "move", slot: 1 });
    expect(greedyPolicy(battle(COMMAND, party, [snorlax()]), moves(2))).toEqual({ kind: "move", slot: 0 });
  });

  it("counts damage only up to the HP left or the boss's shield, times accuracy", () => {
    // Fire Blast (110, 85%) beats Flamethrower (90, 100%) on a healthy enemy, not when either one finishes it.
    const party = [knowing([MoveId.FIRE_BLAST, MoveId.FLAMETHROWER])];
    expect(greedyPolicy(battle(COMMAND, party, [snorlax()]), moves(2))).toEqual({ kind: "move", slot: 0 });
    expect(greedyPolicy(battle(COMMAND, party, [snorlax({ hp: 0.05 })]), moves(2))).toEqual({ kind: "move", slot: 1 });
    const boss = snorlax({ hp: 0.55, bossSegments: 2, bossSegmentIndex: 1 });
    expect(greedyPolicy(battle(COMMAND, party, [boss]), moves(2))).toEqual({ kind: "move", slot: 1 });
  });

  it("switches to the bench Pokémon with a damaging move when no move does damage", () => {
    const stuck = knowing([MoveId.TACKLE, MoveId.GROWL]);
    const bench = [
      knowing([MoveId.GROWL], { fieldIndex: -1 }),
      knowing([MoveId.EMBER], { fieldIndex: -1 }),
    ];
    const legal: Action[] = [...moves(2), { kind: "switch", partySlot: 1 }, { kind: "switch", partySlot: 2 }];
    const ghost = snorlax({ types: [PokemonType.GHOST] });
    expect(greedyPolicy(battle(COMMAND, [stuck, ...bench], [ghost]), legal)).toEqual({
      kind: "switch",
      partySlot: 2,
    });
    // No bench Pokémon does better: it stays and uses a move.
    const legalStay: Action[] = [...moves(2), { kind: "switch", partySlot: 1 }];
    expect(greedyPolicy(battle(COMMAND, [stuck, bench[0]], [ghost]), legalStay).kind).toBe("move");
  });

  it("targets the enemy it damages most in a double battle", () => {
    const party = [knowing([MoveId.TACKLE])];
    const enemies = [snorlax({ types: [PokemonType.GHOST] }), snorlax({ fieldIndex: 1 })];
    const stage: StageObs = { kind: "target", fieldIndex: 0, moveId: MoveId.TACKLE };
    const legal: Action[] = [BattlerIndex.PLAYER_2, BattlerIndex.ENEMY, BattlerIndex.ENEMY_2].map(target => ({
      kind: "target",
      target,
    }));
    expect(greedyPolicy(battle(stage, party, enemies), legal)).toEqual({ kind: "target", target: BattlerIndex.ENEMY_2 });
  });

  it("switches out of a bad matchup to a healthy Pokémon that does twice the damage", () => {
    // Ember on a Water type: 1.5 STAB × 0.5. Thunder Shock: 2× with no STAB.
    const active = knowing([MoveId.EMBER]);
    const legal: Action[] = [...moves(1), { kind: "switch", partySlot: 1 }];
    const water = snorlax({ types: [PokemonType.WATER] });
    const bench = (hp: number) => knowing([MoveId.THUNDER_SHOCK], { fieldIndex: -1, hp });
    expect(greedyPolicy(battle(COMMAND, [active, bench(100)], [water]), legal)).toEqual(legal[1]);
    // Not into a Pokémon below half HP, and not for a move that is no better.
    expect(greedyPolicy(battle(COMMAND, [active, bench(40)], [water]), legal)).toEqual(legal[0]);
    expect(greedyPolicy(battle(COMMAND, [active, bench(100)], [snorlax()]), legal)).toEqual(legal[0]);
  });

  describe("rewards", () => {
    const option = (id: string) => ({ id, args: [], tier: 0, cost: 0, upgradeCount: 0 });
    /** The reward screen with free `options` and shop `shop`, all legal. */
    function rewardScreen(party: OwnPokemonObs[], options: string[], shop: string[] = []) {
      const stage: StageObs = { kind: "reward", options: options.map(option), shop: shop.map(option), rerollCost: 0 };
      const legal: Action[] = [
        ...options.map((_, index) => ({ kind: "reward" as const, index })),
        ...shop.map((_, index) => ({ kind: "buy" as const, index })),
        { kind: "skipReward" },
      ];
      return greedyPolicy({ ...obs(), stage, party }, legal);
    }
    const healthy = [user(), user()];
    const hurt = [user(), user({ hp: 40 })];
    const fainted = [user({ hp: 40 }), user({ hp: 0 })];

    it("takes healing when a Pokémon is below half HP, a revive when one has fainted", () => {
      expect(rewardScreen(healthy, ["POTION", "RARE_CANDY"])).toEqual({ kind: "reward", index: 1 });
      expect(rewardScreen(hurt, ["RARE_CANDY", "POTION"])).toEqual({ kind: "reward", index: 1 });
      expect(rewardScreen(fainted, ["POTION", "REVIVE"])).toEqual({ kind: "reward", index: 1 });
    });

    it("buys healing first while a Pokémon is below half HP", () => {
      expect(rewardScreen(hurt, ["RARE_CANDY"], ["ETHER", "POTION"])).toEqual({ kind: "buy", index: 1 });
      expect(rewardScreen(healthy, ["RARE_CANDY"], ["POTION"])).toEqual({ kind: "reward", index: 0 });
    });

    it("takes balls and lures last and never a move-teaching item", () => {
      expect(rewardScreen(healthy, ["POKEBALL", "LURE", "BERRY"])).toEqual({ kind: "reward", index: 2 });
      expect(rewardScreen(healthy, ["TM_COMMON", "POKEBALL"])).toEqual({ kind: "reward", index: 1 });
      expect(rewardScreen(healthy, ["TM_COMMON", "MEMORY_MUSHROOM"])).toEqual({ kind: "skipReward" });
    });

    it("heals the Pokémon with the least HP left and revives the highest level", () => {
      const party = [user({ hp: 60 }), user({ hp: 30 }), user({ hp: 0, level: 40 }), user({ hp: 0, level: 45 })];
      const targets = (slots: number[]): Action[] => slots.map(partySlot => ({ kind: "itemTarget", partySlot }));
      const at = (id: string, legal: Action[]) =>
        greedyPolicy({ ...obs(), stage: { kind: "itemTarget", item: { id, args: [] } }, party }, legal);
      expect(at("POTION", targets([0, 1]))).toEqual({ kind: "itemTarget", partySlot: 1 });
      expect(at("REVIVE", targets([2, 3]))).toEqual({ kind: "itemTarget", partySlot: 3 });
    });
  });

  it("learns a new move only over a weaker one", () => {
    const party = [knowing([MoveId.EMBER, MoveId.FLAMETHROWER, MoveId.GROWL, MoveId.TACKLE])];
    const legal: Action[] = [0, 1, 2, 3].map(forget => ({ kind: "learnMove", forget }));
    legal.push({ kind: "skipMove" });
    const learn = (moveId: MoveId) =>
      greedyPolicy({ ...obs(), stage: { kind: "learnMove", partySlot: 0, moveId }, party }, legal);
    expect(learn(MoveId.FIRE_BLAST)).toEqual({ kind: "learnMove", forget: 2 });
    expect(learn(MoveId.LEER)).toEqual({ kind: "skipMove" });
  });

  it("sends in the Pokémon whose best move does the most after a faint", () => {
    const party = [
      knowing([MoveId.TACKLE], { hp: 0 }),
      knowing([MoveId.TACKLE], { fieldIndex: -1 }),
      knowing([MoveId.WATER_GUN], { fieldIndex: -1 }),
    ];
    const legal: Action[] = [1, 2].map(partySlot => ({ kind: "switch", partySlot }));
    const ghost = snorlax({ types: [PokemonType.GHOST] });
    expect(greedyPolicy(battle({ kind: "switch", fieldIndex: 0 }, party, [ghost]), legal)).toEqual({
      kind: "switch",
      partySlot: 2,
    });
  });
});

describe("greedyPolicy in real runs", () => {
  it.each(["greedy-1", "greedy-2", "greedy-3"])("plays %s to game over", { timeout: 300_000 }, async seed => {
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const kinds = new Set<string>();
    let decision = await driver.next();
    while (decision.kind !== "gameOver" && decision.kind !== "truncated") {
      const action = greedyPolicy(driver.observe(), decision.legal);
      kinds.add(action.kind);
      driver.act(action);
      decision = await driver.next();
    }
    console.info(`${seed}: ${decision.kind} on wave ${game.scene.currentBattle.waveIndex}, actions ${[...kinds]}`);
    driver.dispose();
    expect(decision.kind).toBe("gameOver");
  });
});
