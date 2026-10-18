// Batch runner (issue #9): plays many runs back to back in one process and writes one JSON line per run.
// Each run is the real game (startClassicRun, mystery encounters on) with a random starter team
// (randomTeam) and a policy, played until game over or until the driver truncates it. One `it` per run,
// so the harness resets the game between runs (one GameManager per test).
//
// Environment: BATCH_PREFIX (seeds are `<prefix>-<n>`, default "batch"), BATCH_START (first n, default 0),
// BATCH_COUNT (number of runs, default 10), BATCH_OUT (JSON lines file, default runs/games.jsonl),
// BATCH_LEVEL (starters' level, through the harness's startingLevel override; default 0: the real game's),
// BATCH_POLICY ("default", or "random": uniform over legal actions, seeded from the run's seed).
// scripts/run_games.sh launches several of these processes and summarizes their files.
//
// A truncated run's record has the actions the policy took (issue #53), so it can be replayed whatever
// policy played it. BATCH_REPLAY (a file of these records, e.g. a batch's runs.jsonl) replays every record
// in it that has actions instead: same seed, level and actions. scripts/replay_runs.sh does that.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, it } from "vitest";
import { type Action, type Decision, Driver, type StallReport } from "../driver";
import { defaultPolicy, type Policy, randomPolicy, replayPolicy } from "../policy";
import { startClassicRun } from "../run";
import { randomTeam } from "../team";

const PREFIX = process.env.BATCH_PREFIX ?? "batch";
const START = Number(process.env.BATCH_START ?? 0);
const COUNT = Number(process.env.BATCH_COUNT ?? 10);
const LEVEL = Number(process.env.BATCH_LEVEL ?? 0);
const POLICY = process.env.BATCH_POLICY ?? "default";
const REPLAY = process.env.BATCH_REPLAY;
const OUT = resolve(process.env.BATCH_OUT ?? resolve(import.meta.dirname, "../../runs/games.jsonl"));

/** A run to play: its seed, level, and the actions to replay (none: play `POLICY`). */
interface Job {
  seed: string;
  level: number;
  actions?: Action[];
}

const JOBS: Job[] = REPLAY
  ? readFileSync(REPLAY, "utf8")
      .split("\n")
      .filter(line => line.trim() !== "")
      .map(line => JSON.parse(line) as RunRecord)
      .filter(r => r.actions != null)
      .map(r => ({ seed: r.seed, level: r.level, actions: r.actions! }))
  : Array.from({ length: COUNT }, (_, i) => ({ seed: `${PREFIX}-${START + i}`, level: LEVEL }));

/** The policy for a run. */
function policyFor(job: Job): Policy {
  if (job.actions) {
    return replayPolicy(job.actions);
  }
  switch (POLICY) {
    case "default":
      return defaultPolicy;
    case "random":
      return randomPolicy(job.seed);
    default:
      throw new Error(`Unknown BATCH_POLICY ${POLICY}`);
  }
}

/** One line of the output file. */
interface RunRecord {
  seed: string;
  /** The starters' level override, or 0 for the real game's. */
  level: number;
  /** default or random (BATCH_POLICY), or replay. */
  policy: string;
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
  /** How many actions of each kind the policy took, to see which game states a policy reaches. */
  actionKinds: Partial<Record<Action["kind"], number>>;
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
  /** Every action the policy took, in order, for a truncated run or an error; null otherwise. */
  actions: Action[] | null;
}

describe("batch of Classic runs", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    mkdirSync(dirname(OUT), { recursive: true });
  });

  it.each(JOBS.map(job => [job.seed, job] as const))("%s", { timeout: 600_000 }, async (seed, job) => {
    const team = randomTeam(seed);
    const policy = policyFor(job);
    const actions: Action[] = [];
    const record: RunRecord = {
      seed,
      level: job.level,
      policy: job.actions ? "replay" : POLICY,
      team: team.map(id => SpeciesId[id]),
      outcome: "error",
      reason: null,
      wave: 0,
      turns: 0,
      maxWaveTurns: 0,
      decisions: 0,
      actionKinds: {},
      phases: 0,
      maxPhasesPerNext: 0,
      mysteryEncounters: [],
      startedAt: Date.now(),
      bootMs: 0,
      wallMs: 0,
      heapMb: 0,
      stall: null,
      actions: null,
    };
    let driver: Driver | undefined;
    const t0 = performance.now();
    try {
      const game = new GameManager(phaserGame);
      if (job.level > 0) {
        game.override.startingLevel(job.level);
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
        const action = policy(driver.observe(), decision.legal);
        actions.push(action);
        record.actionKinds[action.kind] = (record.actionKinds[action.kind] ?? 0) + 1;
        driver.act(action);
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
      if (record.outcome === "truncated" || record.outcome === "error") {
        record.actions = actions;
      }
      appendFileSync(OUT, `${JSON.stringify(record)}\n`);
    }
  });
});
