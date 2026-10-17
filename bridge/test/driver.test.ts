// Plays a Classic run through bridge/driver.ts with the same battle choices as classic-run.test.ts (the
// default policy's), so their turns/s can be compared: the driver steps phases directly, the smoke test
// goes through the harness's PhaseInterceptor. Run with scripts/test_bridge.sh.

import { BattleType } from "#enums/battle-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";
import { Driver } from "../driver";
import { defaultPolicy, type Policy } from "../policy";

const WAVES = 10;
const TURN_BUDGET = 150;

/** The default policy, but never take rewards (the harness skips them too). */
const policy: Policy = (obs, legal) =>
  obs.stage.kind === "reward" ? { kind: "skipReward" } : defaultPolicy(obs, legal);

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
        driver.act(policy(driver.observe(), decision.legal));
        decisions++;
      }
    }
    log.push(end);
    driver.dispose();

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
