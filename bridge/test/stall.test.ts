// Stall detection (issue #9): runs that can't finish end as a `truncated` decision with a stall report,
// logged as one JSON line, and the next run in the same process plays normally. Each stall is made on
// purpose: a phase that never ends, a phase loop with no decisions, a screen answered the same way forever,
// a stalemate that only a turn cap ends, and game code that throws (on purpose and in a real run). Also
// the double-battle flee that used to crash the harness now plays on.
// Run with scripts/test_bridge.sh stall.

import { globalScene } from "#app/global-scene";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { CommandPhase } from "#phases/command-phase";
import { TurnEndPhase } from "#phases/turn-end-phase";
import { TurnInitPhase } from "#phases/turn-init-phase";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Decision, Driver, type StallLimits } from "../driver";
import { defaultPolicy, type Policy } from "../policy";
import { startClassicRun } from "../run";
import { randomTeam } from "../team";

const STARTERS = [SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR];
/** No damaging move on either side (all four player moves: the override only replaces the first ones). */
const NO_DAMAGE = [MoveId.SPLASH, MoveId.CELEBRATE, MoveId.HOLD_HANDS, MoveId.HAPPY_HOUR];

/** Play `policy` until the run ends; return the last decision and the JSON lines the driver logged. */
async function play(driver: Driver, policy: Policy = defaultPolicy) {
  const warn = vi.spyOn(console, "warn");
  let decision: Decision;
  for (;;) {
    decision = await driver.next();
    if (decision.kind === "gameOver" || decision.kind === "truncated") {
      break;
    }
    driver.act(policy(driver.observe(), decision.legal));
  }
  const logged = warn.mock.calls
    .map(args => String(args[0]))
    .filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line));
  warn.mockRestore();
  return { decision, logged };
}

describe("stall detection", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  async function boot(seed: string, limits: Partial<StallLimits> = {}) {
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...STARTERS);
    return { game, driver: new Driver(game, limits) };
  }

  it("truncates a run whose phase never ends, and logs where", async () => {
    const { driver } = await boot("stall-phase", { phaseTimeoutMs: 300 });
    // The first turn's end never comes, with nothing for the player to do.
    vi.spyOn(TurnEndPhase.prototype, "start").mockImplementation(() => {});

    const { decision, logged } = await play(driver);
    expect(decision.kind).toBe("truncated");
    if (decision.kind !== "truncated") {
      return;
    }
    expect(decision.reason).toBe("phaseTimeout");
    expect(decision.legal).toEqual([]);
    expect(decision.stall).toMatchObject({
      reason: "phaseTimeout",
      seed: "stall-phase",
      wave: 1,
      biome: "TOWN",
      phase: "TurnEndPhase",
      lastDecision: "command",
      turns: 1,
      waveTurns: 1,
      error: null,
    });
    expect(decision.stall.detail).toMatch(/^TurnEndPhase running for \d+ ms$/);
    expect(logged).toEqual([{ event: "truncated", ...decision.stall }]);

    // The run stays over.
    await expect(driver.next()).resolves.toBe(decision);
    expect(() => driver.observe()).toThrow(/no pending decision/);
    expect(() => driver.act({ kind: "move", slot: 0 })).toThrow(/no pending decision/);
    driver.dispose();
  });

  it("plays the next run in the same process normally", async () => {
    const { game, driver } = await boot("stall-next");
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(1);
    driver.dispose();
  });

  it("truncates a phase loop with no decisions or turn ends", async () => {
    const { driver } = await boot("stall-loop", { maxStepsWithoutProgress: 200 });
    // Each TurnInitPhase queues another and ends, so the run never asks for a command.
    vi.spyOn(TurnInitPhase.prototype, "start").mockImplementation(function (this: TurnInitPhase) {
      globalScene.phaseManager.unshiftNew("TurnInitPhase");
      this.end();
    });

    const { decision } = await play(driver);
    expect(decision).toMatchObject({ kind: "truncated", reason: "noProgress", stall: { phase: "TurnInitPhase" } });
    driver.dispose();
  });

  it("truncates the same screen answered forever", async () => {
    const { driver } = await boot("stall-screen", { maxStepsWithoutProgress: 300 });
    // The game refuses every command and asks again, as it does (with a message) for a move it won't allow.
    vi.spyOn(CommandPhase.prototype, "handleCommand").mockImplementation(function (this: CommandPhase) {
      globalScene.ui.setMode(UiMode.COMMAND, this.getFieldIndex());
      return false;
    });

    const { decision } = await play(driver);
    expect(decision).toMatchObject({
      kind: "truncated",
      reason: "noProgress",
      stall: { phase: "CommandPhase", lastDecision: "command", decisions: expect.any(Number) },
    });
    expect(decision.kind === "truncated" && decision.stall.decisions).toBeGreaterThan(250);
    driver.dispose();
  });

  it.each([
    { cap: "waveTurnCap", limits: { waveTurnCap: 30 }, turns: 30 },
    { cap: "runTurnCap", limits: { runTurnCap: 25 }, turns: 25 },
  ] as const)("ends a stalemate at the $cap", async ({ cap, limits, turns }) => {
    const game = new GameManager(phaserGame);
    game.override.moveset(NO_DAMAGE).enemyMoveset(MoveId.SPLASH);
    await startClassicRun(game, `stall-${cap}`, ...STARTERS);
    const driver = new Driver(game, limits);

    const { decision } = await play(driver);
    expect(decision).toMatchObject({ kind: "truncated", reason: cap, stall: { wave: 1, turns, waveTurns: turns } });
    driver.dispose();
  });

  it("ends the run when game code throws in a phase", async () => {
    const { driver } = await boot("stall-crash-phase");
    vi.spyOn(TurnEndPhase.prototype, "start").mockImplementation(() => {
      throw new Error("boom in a phase");
    });

    const { decision } = await play(driver);
    expect(decision).toMatchObject({
      kind: "truncated",
      reason: "crash",
      stall: { detail: "Error: boom in a phase", phase: "TurnEndPhase" },
    });
    expect(decision.kind === "truncated" && decision.stall.error).toMatch(/boom in a phase\n\s+at /);
    driver.dispose();
  });

  it("ends the run when game code throws while applying an action", async () => {
    const { driver } = await boot("stall-crash-act");
    vi.spyOn(CommandPhase.prototype, "handleCommand").mockImplementation(() => {
      throw new Error("boom in an answer");
    });

    const { decision } = await play(driver);
    expect(decision).toMatchObject({
      kind: "truncated",
      reason: "crash",
      stall: { detail: "Error: boom in an answer", lastDecision: "command" },
    });
    driver.dispose();
  });

  // An upstream crash: both player Pokémon of a double battle faint with the last enemy, the switch that
  // FaintPhase queued for field slot 1 runs in the next (single) battle, and the summoned Pokémon has no
  // battler index (PostSummonPhasePriorityQueue, "reading 'getAbilityPriorities'").
  it("ends a run that crashes in game code as truncated", async () => {
    const seed = "big-1951";
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision).toMatchObject({
      kind: "truncated",
      reason: "crash",
      stall: { wave: 7, phase: "SwitchSummonPhase", lastDecision: "switch" },
    });
    expect(decision.kind === "truncated" && decision.stall.detail).toMatch(/getAbilityPriorities/);
    driver.dispose();
  });

  // Fleeing a double wild battle used to crash in CommonBattleAnim.play on wave 31 of this run (a trap's
  // damage animation aimed at an enemy the flee had destroyed; see bridge/run.ts).
  it("plays on after fleeing a double battle with a trapped enemy", { timeout: 120_000 }, async () => {
    const seed = "me-run-random-legendary-18";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, SpeciesId.MEWTWO, SpeciesId.RAYQUAZA, SpeciesId.GROUDON);
    const driver = new Driver(game);
    // The random policy of encounter-runs.test.ts.
    let state = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const random: Policy = (_obs, legal) => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return legal[state % legal.length];
    };

    const { decision } = await play(driver, random);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(31);
    driver.dispose();
  });
});
