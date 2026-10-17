// Plays a Classic run through bridge/driver.ts with the same fixed policy as classic-run.test.ts, so
// their turns/s can be compared: the driver steps phases directly, the smoke test goes through the
// harness's PhaseInterceptor. Run with scripts/test_bridge.sh.

import { BattleType } from "#enums/battle-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";
import { type Action, type Decision, Driver } from "../driver";
import { defaultAction } from "../policy";

const WAVES = 10;
const TURN_BUDGET = 150;

/**
 * Highest-power usable move on the first active enemy; first healthy bench Pokémon; never take rewards.
 * Other decisions get the default policy.
 */
function policy(game: GameManager, decision: Exclude<Decision, { kind: "gameOver" }>): Action {
  const scene = game.scene;
  switch (decision.kind) {
    case "command": {
      const pokemon = scene.getPlayerField()[decision.fieldIndex];
      const moveset = pokemon.getMoveset();
      const usable = moveset.filter(m => m.isUsable(pokemon)[0]);
      const move = usable.reduce((a, b) => (b.getMove().power > a.getMove().power ? b : a));
      return { kind: "move", slot: moveset.indexOf(move) };
    }
    case "target":
      return { kind: "target", target: scene.getEnemyField().find(e => e.isActive(true))!.getBattlerIndex() };
    case "switch": {
      const party = scene.getPlayerParty();
      const slots = scene.currentBattle.getBattlerCount();
      return { kind: "switch", partySlot: party.findIndex((p, i) => i >= slots && !p.isFainted()) };
    }
    case "reward":
      return { kind: "skipReward" };
    default:
      return defaultAction(scene, decision);
  }
}

describe("Classic run (driver)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it(`plays up to ${WAVES} waves`, { timeout: 120_000 }, async () => {
    const t0 = performance.now();
    const game = new GameManager(phaserGame);
    await game.classicMode.runToSummon(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
    // generateStarters() skips the starter-select UI, which is what normally fills player movesets.
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.generateAndPopulateMoveset();
    }
    const driver = new Driver(game);
    const tBoot = performance.now();

    const log: string[] = [];
    let wave = game.scene.currentBattle.waveIndex;
    let decisions = 0;
    let end = "";
    while (!end) {
      const decision = await driver.next();
      const battle = game.scene.currentBattle;
      wave = battle.waveIndex;
      if (decision.kind === "gameOver") {
        end = `game over on wave ${wave}`;
      } else if (wave > WAVES) {
        end = `reached wave ${wave}`;
      } else if (driver.turns >= TURN_BUDGET) {
        end = `turn budget ran out on wave ${wave}`;
      } else {
        if (decision.kind === "reward") {
          const enemies = battle.enemyParty.map(p => `${p.name} L${p.level}`).join(", ");
          log.push(`wave ${wave} (${BattleType[battle.battleType]}${battle.double ? " double" : ""}): beat ${enemies}`);
        }
        driver.act(policy(game, decision));
        decisions++;
      }
    }
    log.push(end);

    const bootSeconds = (tBoot - t0) / 1000;
    const playSeconds = (performance.now() - tBoot) / 1000;
    console.info(
      `\n=== Classic run (driver) ===\n${log.join("\n")}\n`
        + `boot ${bootSeconds.toFixed(1)}s; ${driver.turns} turns, ${decisions} decisions, ${driver.phasesRun} phases `
        + `in ${playSeconds.toFixed(2)}s (${(driver.turns / playSeconds).toFixed(1)} turns/s)\n`,
    );
    expect(driver.turns).toBeGreaterThan(0);
    expect(wave).toBeGreaterThan(1);
  });
});
