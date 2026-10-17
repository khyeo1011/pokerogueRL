// Full Classic runs through the driver: each must reach game over or a win without getting stuck at any
// screen (issue #7), mystery encounters included (issue #8, at the game's own rate from wave 10).
//   - The real game (startClassicRun) with the default policy (bridge/policy.ts).
//   - Starters at level 100, to reach later waves and their screens (biome forks, evolutions, trainers,
//     doubles), with the default policy and with a seeded random policy. The random one picks any legal
//     action, so it also exercises balls, running, switching, the shop, rerolls, releases and cancels.
// Both policies get each decision's observation (issue #10), which must have only allowed fields.
// Run with scripts/test_bridge.sh full-run.

import { BattleStyle } from "#enums/battle-style";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";
import { type Decision, Driver } from "../driver";
import { defaultPolicy, type Policy } from "../policy";
import { startClassicRun } from "../run";
import { disallowedPaths } from "./observation-helpers";
import { nextDecision } from "./play";

/** Battle styles alternate: Switch (the game's default) asks checkSwitch every wave. */
const RUNS = [
  { seed: "full-1", style: BattleStyle.SET, level: 0, policy: "default" },
  { seed: "full-2", style: BattleStyle.SWITCH, level: 0, policy: "default" },
  { seed: "full-3", style: BattleStyle.SET, level: 0, policy: "default" },
  { seed: "full-4", style: BattleStyle.SWITCH, level: 0, policy: "default" },
  { seed: "full-5", style: BattleStyle.SET, level: 100, policy: "default" },
  { seed: "full-6", style: BattleStyle.SWITCH, level: 100, policy: "default" },
  { seed: "full-7", style: BattleStyle.SET, level: 100, policy: "random" },
  { seed: "full-8", style: BattleStyle.SWITCH, level: 100, policy: "random" },
] as const;

/** Ends a stalemate (e.g. both sides at -6 accuracy). Not reached so far. */
const TURN_BUDGET = 5000;

/** A random policy seeded from a string (a small LCG, so runs are repeatable). */
function randomPolicy(seed: string): Policy {
  let state = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (_obs, legal) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return legal[state % legal.length];
  };
}

describe("Classic run through the driver", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it.each(RUNS)(
    "$seed: $policy policy, starters at level $level (0: real game)",
    { timeout: 300_000 },
    async ({ seed, style, level, policy }) => {
      const game = new GameManager(phaserGame);
      game.settings.battleStyle(style);
      if (level > 0) {
        game.override.startingLevel(level);
      }
      await startClassicRun(game, seed, SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
      const driver = new Driver(game);
      const choose = policy === "random" ? randomPolicy(seed) : defaultPolicy;
      const t0 = performance.now();

      const counts: Partial<Record<Decision["kind"], number>> = {};
      const encounters: string[] = [];
      let decision: Decision;
      for (;;) {
        decision = await nextDecision(game, driver);
        counts[decision.kind] = (counts[decision.kind] ?? 0) + 1;
        const wave = game.scene.currentBattle.waveIndex;
        if (decision.kind === "mysteryEncounter" && !decision.followUp && !encounters.at(-1)?.endsWith(`@${wave}`)) {
          encounters.push(`${MysteryEncounterType[decision.encounterType]}@${wave}`);
        }
        if (decision.kind === "gameOver" || driver.turns >= TURN_BUDGET) {
          break;
        }
        // Both policies get the observation, so this also checks it at every decision.
        const obs = driver.observe();
        expect(disallowedPaths(obs)).toEqual([]);
        driver.act(choose(obs, decision.legal));
      }

      driver.dispose();
      const seconds = (performance.now() - t0) / 1000;
      const end = decision.kind === "gameOver" ? (decision.victory ? "won" : "game over") : "turn budget ran out";
      const party = game.scene
        .getPlayerParty()
        .map(p => `${p.name} L${p.level}`)
        .join(", ");
      console.info(
        `\n=== ${seed} (${policy} policy, level ${level || "real"}, ${BattleStyle[style]}) ===\n`
          + `${end} on wave ${game.scene.currentBattle.waveIndex}; ${driver.turns} turns in ${seconds.toFixed(1)}s\n`
          + `party: ${party}\ndecisions: ${JSON.stringify(counts)}\n`
          + `mystery encounters (${encounters.length}): ${encounters.join(" ")}\n`,
      );
      expect(decision.kind).toBe("gameOver");
    },
  );
});
