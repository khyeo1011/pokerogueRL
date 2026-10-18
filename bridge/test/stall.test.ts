// Stall detection (issue #9): runs that can't finish end as a `truncated` decision with a stall report,
// logged as one JSON line, and the next run in the same process plays normally. Each stall is made on
// purpose: a phase that never ends, a phase loop with no decisions, a screen answered the same way forever,
// a stalemate that only a turn cap ends, game code that throws, and a screen with no legal action. Also runs
// that used to stall or crash and now play to the end.
// Run with scripts/test_bridge.sh stall.

import { globalScene } from "#app/global-scene";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { CommandPhase } from "#phases/command-phase";
import { TurnEndPhase } from "#phases/turn-end-phase";
import { TurnInitPhase } from "#phases/turn-init-phase";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Decision, Driver, type StallLimits } from "../driver";
import { defaultPolicy, type Policy, randomPolicy } from "../policy";
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

  it("ends a run with no legal action as truncated", async () => {
    const game = new GameManager(phaserGame);
    await startClassicRun(game, "stall-no-action", SpeciesId.CHARMANDER);
    // A party screen to switch the only Pokémon: nothing to send out, and the driver offers no cancel.
    game.scene.phaseManager.unshiftNew("SwitchPhase", SwitchType.SWITCH, 0, false, true);
    const driver = new Driver(game);
    const { decision, logged } = await play(driver);
    expect(decision).toMatchObject({
      kind: "truncated",
      reason: "noLegalAction",
      stall: { wave: 1, phase: "SwitchPhase", detail: "switch in SwitchPhase" },
    });
    expect(logged).toEqual([expect.objectContaining({ event: "truncated", reason: "noLegalAction" })]);
    driver.dispose();
  });

  // Issue #51: the lead faints with the last enemy (Struggle recoil, wave 1), and the forced switch FaintPhase
  // queued runs in the next battle, a double one, where party slot 1 counts as a field slot. The party screen
  // offers nothing to send out and can't be cancelled, so this used to end as noLegalAction. The driver now
  // answers with a field slot, and wave 2 sends out the Pokémon left.
  it("plays on after a forced switch left over into a double battle", async () => {
    const seed = "tp-226";
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBe(2);
    expect(game.scene.currentBattle.double).toBe(true);
    // Wave 2 was fought, not ended on the party screen.
    expect(driver.waveTurns).toBeGreaterThan(0);
    driver.dispose();
  });

  // Issue #51, the reverse: both player Pokémon of a double battle faint with the last enemy, and the switch
  // FaintPhase queued for field slot 1 runs in the next battle, a single one, where SwitchSummonPhase crashed
  // (PostSummonPhasePriorityQueue, "reading 'getAbilityPriorities'", wave 7).
  it("plays on after a forced switch left over into a single battle", async () => {
    const seed = "big-1951";
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(7);
    driver.dispose();
  });

  // Issue #51: a transformed enemy (Ditto) recalled when The Expert Pokémon Breeder's battle was lost on wave
  // 92 was destroyed while its assets reloaded, and the load's playAnim() rejected (EnemyPokemon.playSprite,
  // "reading 'play'"). bridge/run.ts drops that error, as a browser would.
  it("plays on after an enemy is destroyed while its assets load", { timeout: 120_000 }, async () => {
    const seed = "tp100-324";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(92);
    driver.dispose();
  });

  // Found by a 10,000-run level-100 batch: an enemy Tatsugiri's Commander animation on wave 74 read the
  // frame of a mock sprite, which has none (PokemonAnimPhase, "reading 'name'"). The driver skips it.
  it("plays on after a Commander animation", { timeout: 120_000 }, async () => {
    const seed = "hunt100-2727";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(74);
    driver.dispose();
  });

  // Found by a level-100 batch: on wave 69, the player's left Pokémon fainted mid-turn and the right one,
  // Wynaut, moved left before using Destiny Bond, still aimed at its old battler index. Destiny Bond's
  // final-boss condition read the missing target (MovePhase, "reading 'isEnemy'"; see bridge/run.ts).
  it("plays on after Destiny Bond from a Pokémon moved to the left mid-turn", { timeout: 120_000 }, async () => {
    const seed = "night100-117133";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(69);
    driver.dispose();
  });

  // This run's lead could only remember Bide, which is unimplemented: picking it with the Memory Mushroom
  // brought the reward screen back unchanged, and the default policy picked it forever (a noProgress
  // truncation). Unimplemented moves are no longer legal targets (bridge/decisions.ts).
  it("doesn't loop on a Memory Mushroom with only an unimplemented move", async () => {
    const seed = "big-1547";
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver);
    expect(decision.kind).toBe("gameOver");
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

  // The runs below were found by random-policy batches (issue #53; notes/2026-10-18-random-policy-hunt.md).

  // Fleeing a double wild battle on wave 31 ended an enemy's Neutralizing Gas, so the other enemy's Insomnia
  // cured its sleep, and the ResetStatusPhase that queued ran after the flee had destroyed it
  // (EnemyPokemon.playSprite, "reading 'play'"; see bridge/run.ts).
  it("plays on after fleeing a double battle that ends Neutralizing Gas", { timeout: 120_000 }, async () => {
    const seed = "rhunt100-35850";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver, randomPolicy(seed));
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(31);
    driver.dispose();
  });

  // A Future Sight that lands after its user switched out can hurt the user back, off the field: on wave 45,
  // an enemy Cramorant's Gulp Missile; on wave 13 of the second run, a fainting Pyukumuku's Innards Out. The
  // damage animation found no Pokémon at battler index -1 (DamageNumberHandler.add, "reading
  // 'getBattlerIndex'"; see bridge/run.ts).
  it.each([
    ["rhunt100-68195", 45],
    ["rhunt100-138254", 13],
  ])("plays on after damage to an off-field Future Sight user (%s)", { timeout: 120_000 }, async (seed, wave) => {
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver, randomPolicy(seed));
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(wave);
    driver.dispose();
  });

  // A Nincada evolved during The Expert Pokémon Breeder's battle on wave 42, when the party was only the
  // chosen Pokémon, so the game added a Shedinja, and the party came back with seven. On wave 55 the seventh
  // was the last that could fight and couldn't be sent out, so the turns went on with no Pokémon to command
  // (a waveTurnCap truncation). The Shedinja check now counts the Pokémon held aside (bridge/run.ts).
  it("keeps the party at six when Nincada evolves in The Expert Pokémon Breeder", { timeout: 120_000 }, async () => {
    const seed = "rhunt100-117628";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver, randomPolicy(seed));
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThan(42);
    expect(game.scene.getPlayerParty().length).toBeLessThanOrEqual(6);
    driver.dispose();
  });

  // In a trainer double battle on wave 62, both player Pokémon fainted with an enemy, leaving one Pokémon to
  // send out. The enemy's switch-in ran first (SwitchSummonPhase is ordered by speed), so the second faint's
  // party screen came before the first switch-in, and both sent out the same Pokémon. The second swap brought
  // a fainted Pokémon back (a waveTurnCap truncation). A Pokémon already chosen to switch in is no longer
  // offered (bridge/decisions.ts).
  it("doesn't send out the same Pokémon for both faints of a double battle", { timeout: 120_000 }, async () => {
    const seed = "rhunt100-113244";
    const game = new GameManager(phaserGame);
    game.override.startingLevel(100);
    await startClassicRun(game, seed, ...randomTeam(seed));
    const driver = new Driver(game);
    const { decision } = await play(driver, randomPolicy(seed));
    expect(decision.kind).toBe("gameOver");
    expect(game.scene.currentBattle.waveIndex).toBeGreaterThanOrEqual(62);
    driver.dispose();
  });
});
