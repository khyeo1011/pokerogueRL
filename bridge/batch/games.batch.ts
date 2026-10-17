// Batch runner (issue #9): plays many runs back to back in one process and writes one JSON line per run.
// Each run is the real game (startClassicRun, mystery encounters on) with a random starter team
// (randomTeam) and the default policy, played until game over or until the driver truncates it. One `it`
// per run, so the harness resets the game between runs (one GameManager per test).
//
// Environment: BATCH_PREFIX (seeds are `<prefix>-<n>`, default "batch"), BATCH_START (first n, default 0),
// BATCH_COUNT (number of runs, default 10), BATCH_OUT (JSON lines file, default runs/games.jsonl),
// BATCH_LEVEL (starters' level, through the harness's startingLevel override; default 0: the real game's).
// scripts/run_games.sh launches several of these processes and summarizes their files.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, it } from "vitest";
import { type Decision, Driver, type StallReport } from "../driver";
import { defaultPolicy } from "../policy";
import { startClassicRun } from "../run";
import { randomTeam } from "../team";

const PREFIX = process.env.BATCH_PREFIX ?? "batch";
const START = Number(process.env.BATCH_START ?? 0);
const COUNT = Number(process.env.BATCH_COUNT ?? 10);
const LEVEL = Number(process.env.BATCH_LEVEL ?? 0);
const OUT = resolve(process.env.BATCH_OUT ?? resolve(import.meta.dirname, "../../runs/games.jsonl"));
const SEEDS = Array.from({ length: COUNT }, (_, i) => `${PREFIX}-${START + i}`);

/** One line of the output file. */
interface RunRecord {
  seed: string;
  /** The starters' level override, or 0 for the real game's. */
  level: number;
  /** Species names, lead first. */
  team: string[];
  /** victory or terminated (game over), truncated (stopped by the driver), error (the runner threw). */
  outcome: "victory" | "terminated" | "truncated" | "error";
  /** The truncation reason, or the error message. */
  reason: string | null;
  wave: number;
  turns: number;
  /** Most turns in one wave. */
  maxWaveTurns: number;
  decisions: number;
  phases: number;
  /** Most phases run by one Driver.next() call. */
  maxPhasesPerNext: number;
  /** Mystery encounters met, as `TYPE@wave`. */
  mysteryEncounters: string[];
  /** When the run started (epoch ms), to measure process startup and the time between runs. */
  startedAt: number;
  /** Wall-clock ms to boot the run, and to play it after boot (game and policy). */
  bootMs: number;
  wallMs: number;
  /** The process's heap after the run (not garbage-collected first), to spot leaks between runs. */
  heapMb: number;
  stall: StallReport | null;
}

describe("batch of Classic runs", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    mkdirSync(dirname(OUT), { recursive: true });
  });

  it.each(SEEDS)("%s", { timeout: 600_000 }, async seed => {
    const team = randomTeam(seed);
    const record: RunRecord = {
      seed,
      level: LEVEL,
      team: team.map(id => SpeciesId[id]),
      outcome: "error",
      reason: null,
      wave: 0,
      turns: 0,
      maxWaveTurns: 0,
      decisions: 0,
      phases: 0,
      maxPhasesPerNext: 0,
      mysteryEncounters: [],
      startedAt: Date.now(),
      bootMs: 0,
      wallMs: 0,
      heapMb: 0,
      stall: null,
    };
    let driver: Driver | undefined;
    const t0 = performance.now();
    try {
      const game = new GameManager(phaserGame);
      if (LEVEL > 0) {
        game.override.startingLevel(LEVEL);
      }
      await startClassicRun(game, seed, ...team);
      record.bootMs = Math.round(performance.now() - t0);
      driver = new Driver(game);
      const wave = () => game.scene.currentBattle.waveIndex;
      const encounterWaves = new Set<number>();
      let decision: Decision;
      for (;;) {
        const phases = driver.phasesRun;
        decision = await driver.next();
        record.maxPhasesPerNext = Math.max(record.maxPhasesPerNext, driver.phasesRun - phases);
        record.maxWaveTurns = Math.max(record.maxWaveTurns, driver.waveTurns);
        if (decision.kind === "gameOver" || decision.kind === "truncated") {
          break;
        }
        // A menu shows again after a dead-end option, so count one encounter per wave.
        if (decision.kind === "mysteryEncounter" && !decision.followUp && !encounterWaves.has(wave())) {
          encounterWaves.add(wave());
          record.mysteryEncounters.push(`${MysteryEncounterType[decision.encounterType]}@${wave()}`);
        }
        driver.act(defaultPolicy(driver.observe(), decision.legal));
      }
      if (decision.kind === "truncated") {
        record.outcome = "truncated";
        record.reason = decision.reason;
        record.stall = decision.stall;
      } else {
        record.outcome = decision.victory ? "victory" : "terminated";
      }
      record.wave = wave();
    } catch (error) {
      record.reason = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (driver != null) {
        record.turns = driver.turns;
        record.decisions = driver.decisions;
        record.phases = driver.phasesRun;
        driver.dispose();
      }
      record.wallMs = Math.round(performance.now() - t0) - record.bootMs;
      record.heapMb = Math.round(process.memoryUsage().heapUsed / 1e6);
      appendFileSync(OUT, `${JSON.stringify(record)}\n`);
    }
  });
});
