// Full Classic runs on the real game with mystery encounters at their own rate (issue #8): strong
// starters at level 100 reach the waves where encounters spawn (10-180). Each run must end in game over
// or a win without getting stuck; the summary lists the encounters met, by type.
//   - Default policy and a seeded random policy (any legal action, so every option, Pokémon and
//     follow-up entry gets picked sometimes, including declining a move tutor).
//   - Kanto starters, and legendaries that get further.
// ENCOUNTER_RUNS=<n> sets the number of seeds per setting (default 4).
// Run with scripts/test_bridge.sh encounter-runs.

import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Action, type Decision, Driver } from "../driver";
import { defaultAction } from "../policy";
import { startClassicRun } from "../run";
import { nextDecision } from "./play";

const SEEDS = Number(process.env.ENCOUNTER_RUNS ?? 4);
const TEAMS = {
  kanto: [SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR],
  legendary: [SpeciesId.MEWTWO, SpeciesId.RAYQUAZA, SpeciesId.GROUDON],
};
const RUNS = (["default", "random"] as const).flatMap(policy =>
  (["kanto", "legendary"] as const).flatMap(team =>
    Array.from({ length: SEEDS }, (_, i) => ({ seed: `me-run-${policy}-${team}-${i}`, policy, team })),
  ),
);

/** Ends a stalemate. */
const TURN_BUDGET = 5000;

/** A random policy seeded from a string (a small LCG, so runs are repeatable). */
function randomPolicy(seed: string): (decision: Decision) => Action {
  let state = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return decision => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return decision.legal[state % decision.legal.length];
  };
}

describe("Classic runs with mystery encounters", () => {
  let phaserGame: Phaser.Game;
  /** Encounters met per type, over all runs. */
  const met: Record<string, number> = {};
  const results: string[] = [];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterAll(() => {
    const total = Object.values(met).reduce((a, b) => a + b, 0);
    const byType = Object.entries(met)
      .sort(([, a], [, b]) => b - a)
      .map(([type, n]) => `${type} ${n}`)
      .join(", ");
    const unseen = Object.keys(MysteryEncounterType).filter(k => Number.isNaN(Number(k)) && !(k in met));
    console.info(
      `\n=== ${RUNS.length} runs ===\n${results.join("\n")}\n`
        + `${total} mystery encounters, ${Object.keys(met).length} types: ${byType}\nnot met: ${unseen.join(", ")}\n`,
    );
  });

  it.each(RUNS)("$seed", { timeout: 300_000 }, async ({ seed, policy, team }) => {
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...TEAMS[team]);
    const driver = new Driver(game);
    const random = randomPolicy(seed);
    const choose = (d: Exclude<Decision, { kind: "gameOver" }>) =>
      policy === "random" ? random(d) : defaultAction(game.scene, d);

    const encounters: string[] = [];
    const encounterWaves = new Set<number>();
    const wave = () => game.scene.currentBattle.waveIndex;
    let decision: Decision;
    for (;;) {
      decision = await nextDecision(game, driver);
      // A menu shows again after a dead-end option, so count one encounter per wave.
      if (decision.kind === "mysteryEncounter" && !decision.followUp && !encounterWaves.has(wave())) {
        encounterWaves.add(wave());
        const type = MysteryEncounterType[decision.encounterType];
        met[type] = (met[type] ?? 0) + 1;
        encounters.push(`${type}@${wave()}`);
      }
      if (decision.kind === "gameOver" || driver.turns >= TURN_BUDGET) {
        break;
      }
      driver.act(choose(decision));
    }

    const end = decision.kind === "gameOver" ? (decision.victory ? "won" : "game over") : "turn budget ran out";
    results.push(`${seed}: ${end} on wave ${game.scene.currentBattle.waveIndex}; ${encounters.join(" ")}`);
    expect(decision.kind).toBe("gameOver");
  });
});
