// Helpers for driver tests. Driver.next() has no watchdog yet (issue #9), so nextDecision() fails a stuck
// run with the phase and UI mode it is stuck at instead of hanging until the test times out.

import { UiMode } from "#enums/ui-mode";
import type { GameManager } from "#test/framework/game-manager";
import type { Decision, Driver } from "../driver";
import { defaultPolicy } from "../policy";

/** How long one Driver.next() may take. A whole wave normally takes well under a second. */
const STUCK_MS = 15_000;

/** Driver.next(), failing with where the game is if no decision comes within `ms`. */
export async function nextDecision(game: GameManager, driver: Driver, ms = STUCK_MS): Promise<Decision> {
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const phase = game.scene.phaseManager.getCurrentPhase()?.phaseName;
      const mode = UiMode[game.scene.ui.mode];
      const wave = game.scene.currentBattle?.waveIndex;
      reject(new Error(`Driver stuck for ${ms} ms in ${phase} with UI mode ${mode} (wave ${wave})`));
    }, ms);
  });
  try {
    return await Promise.race([driver.next(), stuck]);
  } finally {
    clearTimeout(timer);
  }
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
