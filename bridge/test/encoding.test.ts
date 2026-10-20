// Checks the fixed-size encoding (issue #16): every action within the caps has its own index and the
// indices fill [0, N_ACTIONS); every observation encodes to OBS_DIM finite numbers, the same way each
// time; unknown values don't look like real ones; and on real runs the mask allows exactly the legal
// actions. Run with scripts/test_bridge.sh encoding.

import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../decisions";
import { Driver } from "../driver";
import {
  actionIndex,
  actionMask,
  BALLS,
  BIOMES,
  decodeAction,
  encodeObservation,
  MAX_ME_OPTIONS,
  MAX_ME_SUB_OPTIONS,
  MAX_MOVES,
  MAX_PARTY,
  MAX_RELEARN_MOVES,
  MAX_REWARDS,
  MAX_SHOP,
  N_ACTIONS,
  OBS_DIM,
} from "../encoding";
import type { Observation } from "../observation";
import { startClassicRun } from "../run";
import { obs, snorlax, user } from "./built-observations";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Every action that fits the caps. */
function allActions(): Action[] {
  const slots = range(MAX_PARTY);
  return [
    ...range(MAX_MOVES).map(slot => ({ kind: "move", slot }) as const),
    ...range(MAX_MOVES).map(slot => ({ kind: "move", slot, tera: true }) as const),
    ...range(4).map(target => ({ kind: "target", target }) as const),
    ...slots.map(partySlot => ({ kind: "switch", partySlot }) as const),
    ...BALLS.map(ball => ({ kind: "ball", ball }) as const),
    { kind: "run" },
    { kind: "stay" },
    ...range(MAX_REWARDS).map(index => ({ kind: "reward", index }) as const),
    ...range(MAX_SHOP).map(index => ({ kind: "buy", index }) as const),
    { kind: "reroll" },
    { kind: "skipReward" },
    ...slots.map(partySlot => ({ kind: "itemTarget", partySlot }) as const),
    ...slots.flatMap(partySlot =>
      range(MAX_RELEARN_MOVES).map(move => ({ kind: "itemTarget", partySlot, move }) as const),
    ),
    ...slots.flatMap(partySlot => slots.map(fuseWith => ({ kind: "itemTarget", partySlot, fuseWith }) as const)),
    ...range(MAX_MOVES).map(forget => ({ kind: "learnMove", forget }) as const),
    { kind: "skipMove" },
    ...BIOMES.map(biome => ({ kind: "biome", biome }) as const),
    { kind: "evolve" },
    { kind: "cancelEvolution" },
    ...slots.map(partySlot => ({ kind: "release", partySlot }) as const),
    { kind: "keepParty" },
    ...slots.map(partySlot => ({ kind: "revive", partySlot }) as const),
    ...range(MAX_ME_OPTIONS).map(index => ({ kind: "meOption", index }) as const),
    ...slots.map(partySlot => ({ kind: "mePokemon", partySlot }) as const),
    ...range(MAX_ME_SUB_OPTIONS).map(index => ({ kind: "meSubOption", index }) as const),
  ];
}

describe("action space", () => {
  it("gives every action within the caps its own index, filling [0, N_ACTIONS)", () => {
    const actions = allActions();
    expect(actions).toHaveLength(N_ACTIONS);
    expect(actions.map(actionIndex).sort((a, b) => a! - b!)).toEqual(range(N_ACTIONS));
  });

  it("has no slot for actions past a cap", () => {
    const past: Action[] = [
      { kind: "reward", index: MAX_REWARDS },
      { kind: "buy", index: MAX_SHOP },
      { kind: "itemTarget", partySlot: 0, move: MAX_RELEARN_MOVES },
      { kind: "meOption", index: MAX_ME_OPTIONS },
      { kind: "meSubOption", index: MAX_ME_SUB_OPTIONS },
    ];
    expect(past.map(actionIndex)).toEqual(past.map(() => null));
  });

  it("treats an absent tera as tera: false", () => {
    expect(actionIndex({ kind: "move", slot: 2, tera: false })).toBe(actionIndex({ kind: "move", slot: 2 }));
  });

  it("masks exactly the legal actions, and decodes each back", () => {
    const legal: Action[] = [
      { kind: "move", slot: 1 },
      { kind: "switch", partySlot: 3 },
      { kind: "reward", index: 99 },
    ];
    const mask = actionMask(legal);
    expect(mask).toHaveLength(N_ACTIONS);
    expect(mask.filter(Boolean)).toHaveLength(2);
    expect(decodeAction(actionIndex(legal[0])!, legal)).toBe(legal[0]);
    expect(decodeAction(actionIndex(legal[1])!, legal)).toBe(legal[1]);
    expect(() => decodeAction(actionIndex({ kind: "run" })!, legal)).toThrow();
  });
});

describe("observation vector", () => {
  const full = () =>
    ({
      ...obs({ enemies: [snorlax()], double: false }),
      party: [user({ moves: [{ moveId: MoveId.TACKLE, pp: 30, maxPp: 35 }] }), user({ fieldIndex: -1 })],
    }) as const;

  it("has OBS_DIM finite numbers, the same every time", () => {
    const a = encodeObservation(full());
    expect(a).toHaveLength(OBS_DIM);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(encodeObservation(structuredClone(full()))).toEqual(a);
  });

  it("keeps OBS_DIM when lists are empty or over their caps", () => {
    const empty = { ...obs(), party: [] };
    const crowded = { ...full(), party: range(9).map(() => user()) };
    expect(encodeObservation(empty)).toHaveLength(OBS_DIM);
    expect(encodeObservation(crowded)).toHaveLength(OBS_DIM);
  });

  it("tells an unknown enemy ability from a known one", () => {
    const unknown = encodeObservation(obs({ enemies: [snorlax({ revealedAbilityId: null })] }));
    const none = encodeObservation(obs({ enemies: [snorlax({ revealedAbilityId: AbilityId.NONE })] }));
    expect(none).not.toEqual(unknown);
  });

  it("changes when an enemy move is revealed", () => {
    const hidden = encodeObservation(obs({ enemies: [snorlax()] }));
    const seen = encodeObservation(
      obs({ enemies: [snorlax({ revealedMoves: [{ moveId: MoveId.TACKLE, ppUsed: 1 }] })] }),
    );
    expect(seen).not.toEqual(hidden);
  });

  it("encodes every stage kind to OBS_DIM", () => {
    const stages: Observation["stage"][] = [
      { kind: "command", fieldIndex: 0 },
      { kind: "target", fieldIndex: 1, moveId: MoveId.TACKLE },
      { kind: "switch", fieldIndex: 0 },
      { kind: "checkSwitch", fieldIndex: 0 },
      {
        kind: "reward",
        options: range(MAX_REWARDS + 2).map(() => ({ id: "POTION", args: [], tier: 0, cost: 0, upgradeCount: 0 })),
        shop: [{ id: "REVIVE", args: [], tier: 0, cost: 500, upgradeCount: 0 }],
        rerollCost: 250,
      },
      { kind: "itemTarget", item: { id: "TM_COMMON", args: [MoveId.TACKLE] } },
      { kind: "learnMove", partySlot: 0, moveId: MoveId.TACKLE },
      { kind: "evolution", partySlot: 0, speciesId: SpeciesId.CHARMELEON },
      { kind: "revive" },
      { kind: "biome", choices: [BIOMES[1], BIOMES[2]] },
      {
        kind: "mysteryEncounter",
        encounterType: 0,
        tier: 0,
        followUp: false,
        intro: ["hi"],
        title: "t",
        description: "d",
        query: "q",
        options: range(MAX_ME_OPTIONS + 1).map(i => ({
          label: `${i}`,
          tooltip: "",
          disabled: i === 0,
          special: false,
        })),
      },
      { kind: "mePokemon", encounterType: 0, option: 1 },
      { kind: "meSubOption", encounterType: 0, option: 1, labels: range(MAX_ME_SUB_OPTIONS + 3).map(String) },
      { kind: "catch", pokemon: user({ fieldIndex: -1 }) },
    ];
    const vectors = stages.map(stage => encodeObservation({ ...full(), stage }));
    for (const v of vectors) {
      expect(v).toHaveLength(OBS_DIM);
      expect(v.every(Number.isFinite)).toBe(true);
    }
    expect(new Set(vectors.map(v => v.join())).size).toBe(stages.length);
  });
});

describe("real runs", () => {
  let phaserGame: Phaser.Game;
  /** Per seed: the encoded observations of one run, joined. */
  const traces = new Map<string, string[]>();

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  /**
   * Play a run by picking random unmasked indices, as MaskablePPO would, checking the mask against the
   * legal actions and the observation's shape at every decision.
   */
  async function play(seed: string): Promise<string[]> {
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, SpeciesId.MEWTWO, SpeciesId.RAYQUAZA, SpeciesId.GROUDON);
    const driver = new Driver(game);
    let state = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const trace: string[] = [];
    for (let n = 0; n < 1500; n++) {
      const decision = await driver.next();
      if (decision.kind === "gameOver" || decision.kind === "truncated") {
        break;
      }
      const vector = encodeObservation(driver.observe());
      expect(vector).toHaveLength(OBS_DIM);
      expect(vector.every(Number.isFinite)).toBe(true);
      trace.push(vector.join());

      const mask = actionMask(decision.legal);
      const slotted = decision.legal.filter(a => actionIndex(a) !== null);
      expect(mask.filter(Boolean)).toHaveLength(slotted.length);
      for (const action of slotted) {
        expect(decodeAction(actionIndex(action)!, decision.legal)).toBe(action);
      }
      const allowed = range(N_ACTIONS).filter(i => mask[i]);
      state = (state * 1664525 + 1013904223) >>> 0;
      driver.act(decodeAction(allowed[state % allowed.length], decision.legal));
    }
    driver.dispose();
    return trace;
  }

  it.each(["enc-a", "enc-b", "enc-a"])("plays %s on the mask", { timeout: 300_000 }, async seed => {
    const trace = await play(seed);
    expect(trace.length).toBeGreaterThan(20);
    if (traces.has(seed)) {
      expect(trace).toEqual(traces.get(seed));
    }
    traces.set(seed, trace);
  });
});

describe("constants", () => {
  it("match bridge/server.ts", () => {
    const server = readFileSync(resolve(import.meta.dirname, "../server.ts"), "utf8");
    expect(Number(server.match(/const OBS_DIM = (\d+);/)?.[1])).toBe(OBS_DIM);
    expect(Number(server.match(/const N_ACTIONS = (\d+);/)?.[1])).toBe(N_ACTIONS);
  });
});
