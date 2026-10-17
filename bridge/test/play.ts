// Helpers for driver tests. A run the driver truncates (issue #9: a watchdog, a turn cap or a crash) fails
// the test with the driver's stall report, since these tests expect every run to end in game over.

import type { GameManager } from "#test/framework/game-manager";
import type { Decision, Driver } from "../driver";
import { defaultPolicy } from "../policy";

/** Driver.next(), failing with the stall report if the driver truncates the run. */
export async function nextDecision(_game: GameManager, driver: Driver): Promise<Exclude<Decision, { kind: "truncated" }>> {
  const decision = await driver.next();
  if (decision.kind === "truncated") {
    throw new Error(`Run truncated: ${JSON.stringify(decision.stall, null, 2)}`);
  }
  return decision;
}

/** Answer decisions with the default policy until one of `kind` comes up, and return it. */
export async function playUntil<K extends Decision["kind"]>(
  game: GameManager,
  driver: Driver,
  kind: K,
): Promise<Extract<Decision, { kind: K }>> {
  for (;;) {
    const decision = await nextDecision(game, driver);
    if (decision.kind === kind) {
      return decision as Extract<Decision, { kind: K }>;
    }
    if (decision.kind === "gameOver") {
      throw new Error(`Game over on wave ${game.scene.currentBattle.waveIndex} before a ${kind} decision`);
    }
    driver.act(defaultPolicy(driver.observe(), decision.legal));
  }
}
