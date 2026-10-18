// Checks the random policy and replays from recorded actions (issue #53): the random policy picks legal
// actions from its own seeded RNG, and a run replays from its seed and the actions taken, as the batch
// runner records them for truncated runs. Run with scripts/test_bridge.sh.

import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it } from "vitest";
import { type Action, Driver } from "../driver";
import type { Observation } from "../observation";
import { type Policy, randomPolicy, replayPolicy } from "../policy";
import { startClassicRun } from "../run";
import { randomTeam } from "../team";

const LEGAL: Action[] = [0, 1, 2, 3, 4].map(slot => ({ kind: "move", slot }));
/** The random policy never reads the observation. */
const NO_OBS = {} as Observation;

/** `n` picks of `policy` from LEGAL. */
const picks = (policy: Policy, n: number) => Array.from({ length: n }, () => policy(NO_OBS, LEGAL));

describe("randomPolicy", () => {
  it("picks every legal action, the same ones for the same seed", () => {
    const a = picks(randomPolicy("rp-a"), 200);
    expect(new Set(a)).toEqual(new Set(LEGAL));
    expect(picks(randomPolicy("rp-a"), 200)).toEqual(a);
    expect(picks(randomPolicy("rp-b"), 200)).not.toEqual(a);
  });
});

describe("replay from recorded actions", () => {
  let phaserGame: Phaser.Game;
  /** Per run: every decision with its legal actions and the action taken, and the actions alone. */
  const runs: { trace: string[]; actions: Action[] }[] = [];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it.each(["random", "replay"])("plays the run with the %s policy", { timeout: 120_000 }, async name => {
    const seed = "random-replay";
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const policy = name === "random" ? randomPolicy(seed) : replayPolicy(runs[0].actions);
    const trace: string[] = [];
    const actions: Action[] = [];
    for (;;) {
      const decision = await driver.next();
      trace.push(`${game.scene.currentBattle.waveIndex} ${JSON.stringify(decision)}`);
      if (decision.kind === "gameOver" || decision.kind === "truncated") {
        break;
      }
      const action = policy(driver.observe(), decision.legal);
      trace.push(JSON.stringify(action));
      actions.push(action);
      driver.act(action);
    }
    driver.dispose();
    runs.push({ trace, actions });
  });

  it("got the same run twice", () => {
    expect(runs).toHaveLength(2);
    expect(runs[0].actions.length).toBeGreaterThan(10);
    expect(runs[1].trace).toEqual(runs[0].trace);
  });
});
