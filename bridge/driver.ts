// Headless driver: steps pokerogue's phase queue directly instead of through the test harness's
// PhaseInterceptor, which polls every 50 ms for an async phase to finish (issue #2).
//
// Two hooks replace the polling:
//   - phaseManager.startCurrentPhase (called when a phase ends) records the end instead of starting
//     the next phase, so the driver decides when each phase starts.
//   - ui.setModeInternal reports UI modes that wait for player input. These are the decision points.
// Both wake next(), which awaits only while a phase is running asynchronously.
//
// Every decision point of a run without mystery encounters is covered (issue #7; bridge/decisions.ts
// lists what each offers). A decision is answered by calling the callback the game passed to the UI
// mode, or a phase method, never by simulating key presses. Screens that are steps of one choice are
// folded into one decision: learnMove answers both "forget a move?" and the summary screen that picks
// the move, checkSwitch answers "will you switch?" and the party screen, partyFull answers the
// full-party menu and the release screen. Prompts with no effect on play are answered here, not raised.
//
// Mystery encounters (issue #8) add three decisions: the encounter's option menu, the party screen an
// option opens to pick a Pokémon, and follow-up menus (a second pick after the Pokémon, a menu before
// it, or a yes/no prompt). Their battles, reward screens and caught Pokémon use the decisions above.
// Eggs (which encounters hand out) hatch with "skip hatching?" answered yes, and the summary closed.
//
// Each decision comes with its observation (issue #10): raise() takes the StageInput for the decision,
// built from what the UI mode passed, and observe() turns it into the fair-information observation
// (bridge/observation.ts) with the driver's RevealTracker. A policy gets only that observation and the
// legal actions, never the scene. A new decision point passes its StageInput to raise() like the others.
//
// Stalls (issue #9) end the run as a `truncated` decision instead of hanging or throwing, so a batch of
// environments never waits on one game. The watchdogs, with their limits in StallLimits:
//   - noProgress: too many phases and decisions with no turn end and no new wave (a phase loop, or the same
//     screen answered the same way forever). Checked between phases, since such a loop may never yield
//     to the event loop.
//   - phaseTimeout: one phase running too long in wall-clock time (a phase waiting on something the
//     driver doesn't see). Checked between phases and by a timer while next() awaits a phase.
//   - runTimeout: the game's total time in next() over the run (time spent by the policy is not counted).
//   - waveTurnCap / runTurnCap: in-game stalemates (e.g. -6 accuracy against an enemy that never attacks).
//   - noLegalAction: the game waits for a choice the driver can offer no action for.
//   - crash: game code threw, in a phase, an answer, a UI hook or an unhandled rejection while next() ran.
// A truncated run's StallReport (where and why it stopped) is in the decision and logged as one JSON line.
// After truncation the game is in an unknown state: the run is over, and the next run needs a new game.

import type { Phase } from "#app/phase";
import { BiomeId } from "#enums/biome-id";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PartyUiMode } from "#enums/party-ui-mode";
import { UiMode } from "#enums/ui-mode";
import type { Pokemon } from "#field/pokemon";
import { type ModifierType, type ModifierTypeOption, PokemonModifierType } from "#modifiers/modifier-type";
import type { MysteryEncounterOption } from "#mystery-encounters/mystery-encounter-option";
import type { CommandPhase } from "#phases/command-phase";
import type { EvolutionPhase } from "#phases/evolution-phase";
import type { MysteryEncounterPhase } from "#phases/mystery-encounter-phases";
import type { ModifierSelectCallback, SelectModifierPhase } from "#phases/select-modifier-phase";
import type { GameManager } from "#test/framework/game-manager";
import type { ConfirmModeConfig, OptionSelectModeConfig } from "#types/ui-types";
import type { EvolutionSceneUiHandler } from "#ui/evolution-scene-ui-handler";
import { SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import { PartyOption } from "#ui/party-ui-handler";
import { enumValueToKey } from "#utils/enums";
import i18next from "i18next";
import {
  type Action,
  type ActionOf,
  biomeByName,
  canTake,
  commandActions,
  type Decision,
  encounterText,
  itemTargetActions,
  learnMoveActions,
  meOptionActions,
  meOptions,
  mePokemonActions,
  modifierId,
  moveTargets,
  partyFullActions,
  reviveActions,
  sameAction,
  type StallReport,
  shopOptions,
  switchActions,
  type TruncationReason,
} from "./decisions";
import { buildObservation, type Observation, type StageInput } from "./observation";
import { RevealTracker } from "./reveal-tracker";

export type { Action, ActionOf, Decision, MeOption, ShopItem, StallReport, TruncationReason } from "./decisions";

/** When the driver gives up on a run. See the header comment. */
export interface StallLimits {
  /** Phases plus decisions with no turn end and no new wave. A turn is ~23 phases. */
  maxStepsWithoutProgress: number;
  /** Wall-clock ms one phase may run. A whole wave normally takes well under a second. */
  phaseTimeoutMs: number;
  /** Wall-clock ms the game may spend in next() over the whole run. */
  runTimeoutMs: number;
  /** Turns in one wave (an encounter's battles in a row count as one wave). */
  waveTurnCap: number;
  /** Turns in the whole run. */
  runTurnCap: number;
}

/**
 * Default limits (notes/2026-10-17-stall-detection.md). In 2,000 default-policy runs on the real game and
 * 320 with starters at level 100, the longest wave took 86 turns, the longest run 304 turns and one
 * next() call at most 79 phases. The wave cap ends a stalemate after about a second of game time (~3 ms
 * per turn); the run cap is a backstop, well above a full 200-wave run.
 */
export const DEFAULT_STALL_LIMITS: StallLimits = {
  maxStepsWithoutProgress: 5000,
  phaseTimeoutMs: 15_000,
  runTimeoutMs: 300_000,
  waveTurnCap: 300,
  runTurnCap: 10_000,
};

/** How often the watchdog timer checks the running phase while next() awaits it. */
const WATCHDOG_TICK_MS = 250;

type SetModeInternal = (
  mode: UiMode,
  clear: boolean,
  force: boolean,
  chain: boolean,
  args: any[],
) => Promise<void>;

/** Applies an action to the game. Only called with one of the decision's legal actions. */
type Answer = (action: any) => void;

export class Driver {
  /** The current decision, set by the UI hook and cleared by {@linkcode act}. */
  private decision: Decision | null = null;
  /** Applies the action chosen for {@linkcode decision}. */
  private answer: Answer | null = null;
  /** What {@linkcode observe} needs to know about {@linkcode decision}. */
  private input: StageInput | null = null;
  /** The phase the driver started that has not ended yet. */
  private running: Phase | null = null;
  /** Resolves the promise next() is awaiting, if any. */
  private wake: (() => void) | null = null;

  // Answers chosen on the first screen of a folded decision, applied when the next screen opens.
  /** checkSwitch: the party slot to send out. */
  private switchTo: number | null = null;
  /** learnMove: the move slot to forget, or null after skipMove. */
  private learning: { phase: Phase; forget: number | null } | null = null;
  /** partyFull: the party slot to release. */
  private releaseSlot: number | null = null;
  /** The last EvolutionPhase asked about, and the last one cancelled. */
  private evolutionAsked: Phase | null = null;
  private evolutionCancelled: Phase | null = null;
  /** The reward screen's mode arguments, kept to raise it again after a shop purchase. */
  private rewardScreen: { phase: SelectModifierPhase; args: any[] } | null = null;
  /** The modifier type last picked on the reward screen, for the itemTarget decision that follows. */
  private pickedItem: ModifierType | null = null;
  /** The MysteryEncounterPhase whose menu was answered: its menu shows again while the option runs. */
  private meAnswered: Phase | null = null;
  /** The option last picked on an encounter menu, and the options of that menu found to be dead ends. */
  private meChosen = -1;
  private meDeadEnds: { phase: Phase; options: number[] } | null = null;
  /** The phase in which mePokemon was last answered: a menu that follows in it is the second pick. */
  private mePickedIn: Phase | null = null;
  /** The last Pokémon shown in the info box (an encounter's gift Pokémon, for partyFull). */
  private shownPokemon: Pokemon | null = null;
  /** The NewBattlePhase after an encounter for which pending timers were run. */
  private drained: Phase | null = null;
  /** Why the run must stop, set by whatever found out; next() turns it into the truncated decision. */
  private stall: { reason: TruncationReason; detail: string; error?: unknown } | null = null;
  /** The decision that ended the run (gameOver or truncated), returned by every later next(). */
  private outcome: Decision | null = null;
  /** The last decision's kind, for the stall report. */
  private lastDecision: Decision["kind"] | null = null;
  /** performance.now() when the running phase started. */
  private phaseStartedAt = 0;
  /** Phases started and decisions raised since the last turn end or new wave, and that wave. */
  private stepsWithoutProgress = 0;
  private progressWave = -1;
  /** Wall-clock ms spent in next() so far. */
  private gameMs = 0;
  private readonly limits: StallLimits;
  /** Undoes the constructor's hooks. */
  private readonly unhook: () => void;

  /** Enemy moves and abilities revealed so far this run, for the observations. */
  public readonly tracker: RevealTracker;

  /** Number of TurnEndPhases started. */
  public turns = 0;
  /** TurnEndPhases started in the current wave, and that wave. */
  public waveTurns = 0;
  private turnsWave = -1;
  /** Number of phases started. */
  public phasesRun = 0;
  /** Number of decisions raised. */
  public decisions = 0;

  /**
   * Take over the game's phase loop. Call when no phase is running, e.g. right after
   * `classicMode.runToSummon()`, which stops after EncounterPhase ends. `limits` overrides some of
   * {@linkcode DEFAULT_STALL_LIMITS}.
   */
  constructor(
    private readonly game: GameManager,
    limits: Partial<StallLimits> = {},
  ) {
    this.limits = { ...DEFAULT_STALL_LIMITS, ...limits };
    this.tracker = new RevealTracker(game.scene);
    const ui = game.scene.ui as unknown as { setModeInternal: SetModeInternal };
    const pm = game.scene.phaseManager;

    const startCurrentPhase = pm["startCurrentPhase"];
    pm["startCurrentPhase"] = () => {
      this.running = null;
      this.wake?.();
    };

    const setModeInternal = ui.setModeInternal;
    ui.setModeInternal = (mode, clear, force, chain, args) => {
      const done = setModeInternal.call(ui, mode, clear, force, chain, args);
      // A mode is only ready for input once its handler is shown, so act after the transition.
      done.then(() => {
        try {
          this.onModeSet(mode, args);
        } catch (error) {
          this.crashed(error);
        }
      });
      return done;
    };

    const info = game.scene.pokemonInfoContainer;
    const show = info.show;
    info.show = (pokemon: Pokemon, ...rest: any[]) => {
      this.shownPokemon = pokemon;
      return show.call(info, pokemon, ...rest);
    };

    // The harness keeps the scene for the next test, so put its methods back when done.
    this.unhook = () => {
      pm["startCurrentPhase"] = startCurrentPhase;
      ui.setModeInternal = setModeInternal;
      info.show = show;
    };
  }

  /**
   * Run phases until the game waits for the player or the run ends, and return that decision. The run
   * ends with `gameOver` (terminated: lost or won) or `truncated` (stopped by a watchdog, a turn cap or a
   * crash; see the header comment). Once it has ended, every call returns the same decision.
   */
  async next(): Promise<Decision> {
    if (this.outcome != null) {
      return this.outcome;
    }
    const t0 = performance.now();
    const watchdog = setInterval(() => this.checkPhaseTime(), WATCHDOG_TICK_MS);
    const onError = (error: unknown) => this.crashed(error);
    process.on("unhandledRejection", onError);
    process.on("uncaughtException", onError);
    try {
      const decision = await this.step(t0);
      if (decision.kind === "gameOver" || decision.kind === "truncated") {
        this.end(decision);
      } else {
        this.lastDecision = decision.kind;
      }
      return decision;
    } catch (error) {
      this.crashed(error);
      return this.end(this.truncate(t0));
    } finally {
      clearInterval(watchdog);
      process.off("unhandledRejection", onError);
      process.off("uncaughtException", onError);
      this.gameMs += performance.now() - t0;
    }
  }

  /** The loop of {@linkcode next}. */
  private async step(t0: number): Promise<Decision> {
    for (;;) {
      this.checkLimits(t0);
      if (this.stall != null) {
        return this.truncate(t0);
      }
      if (this.decision != null) {
        return this.decision;
      }
      const pm = this.game.scene.phaseManager;
      if (this.running == null) {
        const phase = pm.getCurrentPhase();
        if (phase.is("GameOverPhase")) {
          // GameOverPhase.start asks the encounter first: some survive a lost battle (The Expert Pokémon
          // Breeder), and then the phase just ends.
          const encounter = this.game.scene.currentBattle.mysteryEncounter;
          if (!phase["isVictory"] && encounter?.onGameOver && !encounter.onGameOver()) {
            phase.end();
            continue;
          }
          // Not started, so the game never reaches the title screen.
          return { kind: "gameOver", victory: phase["isVictory"], legal: [] };
        }
        if (phase.is("EvolutionPhase") && phase !== this.evolutionAsked && phase["canCancel"] && phase.validate()) {
          this.askEvolution(phase);
          continue;
        }
        if (phase.is("NewBattlePhase") && phase !== this.drained && this.inMysteryEncounter()) {
          // Encounters can leave timers that still read the encounter (The Strong Stuff hides its visuals
          // 750 ms after the option). The harness's clock runs them 1 ms later in real time, but the driver
          // gets here without yielding, so let them run before the encounter's wave is replaced.
          this.drained = phase;
          await this.drainTimers();
          continue;
        }
        if (phase.is("ScanIvsPhase")) {
          // The IV Scanner only shows enemy IVs. Its start() throws in the harness (mock sprites have no
          // name), so skip it.
          phase.end();
          continue;
        }
      }
      this.wake = null;
      const prom = new Promise<void>(resolve => {
        this.wake = resolve;
      });
      if (this.running == null) {
        this.running = pm.getCurrentPhase();
        this.phaseStartedAt = performance.now();
        this.phasesRun++;
        this.countStep();
        if (this.running.is("TurnEndPhase")) {
          this.countTurn();
        }
        this.running.start();
      }
      await prom;
    }
  }

  /** A phase or decision: progress only if the wave changed. */
  private countStep(): void {
    const wave = this.game.scene.currentBattle?.waveIndex ?? -1;
    if (wave !== this.progressWave) {
      this.progressWave = wave;
      this.stepsWithoutProgress = 0;
    }
    this.stepsWithoutProgress++;
  }

  private countTurn(): void {
    const wave = this.game.scene.currentBattle.waveIndex;
    if (wave !== this.turnsWave) {
      this.turnsWave = wave;
      this.waveTurns = 0;
    }
    this.turns++;
    this.waveTurns++;
    this.stepsWithoutProgress = 0;
  }

  /** Set {@linkcode stall} if a limit is reached. Called between phases. */
  private checkLimits(t0: number): void {
    if (this.stall != null) {
      return;
    }
    const { maxStepsWithoutProgress, runTimeoutMs, waveTurnCap, runTurnCap } = this.limits;
    if (this.waveTurns >= waveTurnCap) {
      this.stall = { reason: "waveTurnCap", detail: `${this.waveTurns} turns in wave ${this.turnsWave}` };
    } else if (this.turns >= runTurnCap) {
      this.stall = { reason: "runTurnCap", detail: `${this.turns} turns in the run` };
    } else if (this.stepsWithoutProgress >= maxStepsWithoutProgress) {
      this.stall = {
        reason: "noProgress",
        detail: `${this.stepsWithoutProgress} phases and decisions with no turn end or new wave`,
      };
    } else if (this.gameMs + performance.now() - t0 >= runTimeoutMs) {
      this.stall = { reason: "runTimeout", detail: `game time over ${runTimeoutMs} ms` };
    } else {
      this.checkPhaseTime();
    }
  }

  /** Set {@linkcode stall} if the running phase has run too long, and wake next() to report it. */
  private checkPhaseTime(): void {
    const ms = performance.now() - this.phaseStartedAt;
    if (this.stall == null && this.running != null && ms >= this.limits.phaseTimeoutMs) {
      this.stall = { reason: "phaseTimeout", detail: `${this.running.phaseName} running for ${Math.round(ms)} ms` };
      this.wake?.();
    }
  }

  /** Game code threw: stop the run (the first error wins) and wake next() to report it. */
  private crashed(error: unknown): void {
    if (this.stall == null) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.stall = { reason: "crash", detail, error };
    }
    this.wake?.();
  }

  /** The truncated decision for {@linkcode stall}. */
  private truncate(t0: number): Decision {
    const { reason, detail, error } = this.stall!;
    const scene = this.game.scene;
    const phase = scene.phaseManager.getCurrentPhase();
    const stall: StallReport = {
      reason,
      detail,
      seed: scene.seed,
      wave: scene.currentBattle?.waveIndex ?? 0,
      biome: scene.arena ? enumValueToKey(BiomeId, scene.arena.biomeId) : null,
      phase: (this.running ?? phase)?.phaseName ?? null,
      uiMode: UiMode[scene.ui.mode] ?? null,
      lastDecision: this.lastDecision,
      turns: this.turns,
      waveTurns: this.waveTurns,
      phases: this.phasesRun,
      decisions: this.decisions,
      gameMs: Math.round(this.gameMs + performance.now() - t0),
      error: error instanceof Error ? (error.stack ?? String(error)) : null,
    };
    console.warn(JSON.stringify({ event: "truncated", ...stall }));
    return { kind: "truncated", reason, stall, legal: [] };
  }

  /** Make `decision` the run's outcome: no decision is pending after it. */
  private end(decision: Decision): Decision {
    this.outcome = decision;
    this.decision = null;
    this.answer = null;
    this.input = null;
    return decision;
  }

  /**
   * Answer the current decision with one of its `legal` actions. The game resumes on the next call to
   * {@linkcode next}. Throws if there is no decision or the action is not legal.
   */
  act(action: Action): void {
    const { decision, answer } = this;
    if (decision == null || answer == null) {
      throw new Error("Driver.act called with no pending decision");
    }
    if (!(decision.legal as Action[]).some(a => sameAction(a, action))) {
      const legal = JSON.stringify(decision.legal);
      throw new Error(`Illegal action ${JSON.stringify(action)} for decision ${decision.kind}; legal: ${legal}`);
    }
    // Clear first: answering can raise the next decision synchronously.
    this.decision = null;
    this.answer = null;
    this.input = null;
    try {
      answer(action);
    } catch (error) {
      // Game code threw while applying a legal action: next() reports it.
      this.crashed(error);
    }
  }

  /**
   * The observation of the current decision: everything a policy may know when choosing one of its
   * `legal` actions. Throws if there is no decision or the run is over.
   */
  observe(): Observation {
    if (this.input == null) {
      throw new Error("Driver.observe called with no pending decision");
    }
    return buildObservation(this.game.scene, this.tracker, this.input);
  }

  /**
   * Stop tracking reveals and remove the driver's hooks from the scene, which the harness reuses for the
   * next test: without this, each run's driver (and everything it references) stays reachable from the
   * scene. Call when done with the run.
   */
  dispose(): void {
    this.tracker.dispose();
    this.unhook();
  }

  /** Turn a finished UI mode change into a decision if the current phase is now waiting for input. */
  private onModeSet(mode: UiMode, args: any[]): void {
    // Skip modes that were replaced while transitioning in.
    if (this.game.scene.ui.mode !== mode) {
      return;
    }
    const phase = this.game.scene.phaseManager.getCurrentPhase();
    switch (mode) {
      case UiMode.COMMAND:
      case UiMode.FIGHT:
        if (phase.is("CommandPhase")) {
          this.raiseCommand(phase);
        }
        break;
      case UiMode.TARGET_SELECT:
        if (phase.is("SelectTargetPhase")) {
          this.raiseTarget(args);
        }
        break;
      case UiMode.PARTY:
        this.onParty(phase, args);
        break;
      case UiMode.CONFIRM:
        this.onConfirm(phase, args[0]);
        break;
      case UiMode.MODIFIER_SELECT:
        if (phase.is("SelectModifierPhase")) {
          this.onRewardScreen(phase, args);
        }
        break;
      case UiMode.SUMMARY:
        // The summary that picks the move to forget, after learnMove chose one.
        if (phase.is("LearnMovePhase") && this.learning?.phase === phase && this.learning.forget != null) {
          const forget = this.learning.forget;
          this.learning = null;
          args[3](forget);
        }
        break;
      case UiMode.OPTION_SELECT:
        if (phase.is("SelectBiomePhase")) {
          this.raiseBiome(args[0]);
        } else if (phase.is("AttemptCapturePhase")) {
          this.raisePartyFull(this.game.scene.getEnemyField()[phase["fieldIndex"]], args[0]);
        } else if (this.inMysteryEncounter()) {
          this.onEncounterMenu(phase, args[0]);
        }
        break;
      case UiMode.MYSTERY_ENCOUNTER:
        if (phase.is("MysteryEncounterPhase") && phase !== this.meAnswered) {
          this.raiseMysteryEncounter(phase);
        }
        break;
      case UiMode.EGG_HATCH_SUMMARY:
        // What pressing cancel on the summary of skipped egg hatches does.
        if (phase.is("EggSummaryPhase")) {
          phase.end();
        }
        break;
      case UiMode.EVOLUTION_SCENE:
        // What pressing cancel during the animation does: the phase reads the flag when the cycle ends.
        if (phase.is("EvolutionPhase") && phase === this.evolutionCancelled) {
          (this.game.scene.ui.getHandler() as EvolutionSceneUiHandler).cancelled = true;
        }
        break;
    }
  }

  /**
   * Make `decision` the current one. `input` describes it for {@linkcode observe}. A decision with no legal
   * action can't be answered, so it truncates the run instead of waiting forever.
   */
  private raise(decision: Decision, input: StageInput, answer: Answer): void {
    if (decision.legal.length === 0) {
      const phase = this.game.scene.phaseManager.getCurrentPhase().phaseName;
      this.stall ??= { reason: "noLegalAction", detail: `${decision.kind} in ${phase}` };
    } else {
      this.decision = decision;
      this.input = input;
      this.answer = answer;
      this.decisions++;
      this.countStep();
    }
    this.wake?.();
  }

  private raiseCommand(phase: CommandPhase): void {
    const fieldIndex = phase.getFieldIndex();
    const decision: Decision = { kind: "command", fieldIndex, legal: commandActions(fieldIndex) };
    this.raise(decision, { kind: "command", fieldIndex }, (action: ActionOf<"move" | "switch" | "ball" | "run">) => {
      // If the game still refuses, it shows a message and asks again, which raises a new decision.
      switch (action.kind) {
        case "move":
          phase.handleCommand(action.tera ? Command.TERA : Command.FIGHT, action.slot, MoveUseMode.NORMAL);
          break;
        case "switch":
          phase.handleCommand(Command.POKEMON, action.partySlot, false);
          break;
        case "ball":
          phase.handleCommand(Command.BALL, action.ball);
          break;
        case "run":
          phase.handleCommand(Command.RUN, 0);
          break;
      }
    });
  }

  private raiseTarget(args: any[]): void {
    const [fieldIndex, moveId, respond] = args;
    const { targets, multiple } = moveTargets(fieldIndex, moveId);
    // A spread move hits every target: the screen only confirms it, so answer here.
    if (multiple || targets.length === 0) {
      respond(targets);
      return;
    }
    const legal = targets.map(target => ({ kind: "target" as const, target }));
    this.raise(
      { kind: "target", fieldIndex, moveId, legal },
      { kind: "target", fieldIndex, moveId },
      (action: ActionOf<"target">) => respond([action.target]),
    );
  }

  private onParty(phase: Phase, args: any[]): void {
    const [partyUiMode, fieldIndex, respond] = args;
    if (phase.is("SwitchPhase")) {
      if (this.switchTo != null) {
        // The party screen after checkSwitch chose a switch.
        const slot = this.switchTo;
        this.switchTo = null;
        respond(slot, PartyOption.SEND_OUT);
        return;
      }
      // SEND_OUT keeps the phase's own switch type, which is BATON_PASS after Baton Pass.
      const decision: Decision = { kind: "switch", fieldIndex, legal: switchActions() };
      this.raise(decision, { kind: "switch", fieldIndex }, (action: ActionOf<"switch">) =>
        respond(action.partySlot, PartyOption.SEND_OUT),
      );
    } else if (phase.is("SelectModifierPhase")) {
      this.raiseItemTarget(partyUiMode, args);
    } else if (
      (phase.is("AttemptCapturePhase") || this.inMysteryEncounter())
      && partyUiMode === PartyUiMode.RELEASE
      && this.releaseSlot != null
    ) {
      // The release screen after partyFull chose a release: PartyUiHandler.doRelease without the UI.
      const slot = this.releaseSlot;
      this.releaseSlot = null;
      this.game.scene.removePartyMemberModifiers(slot);
      this.game.scene.getPlayerParty().splice(slot, 1)[0].destroy();
      respond(slot, PartyOption.RELEASE);
    } else if (phase.is("RevivalBlessingPhase")) {
      this.raise({ kind: "revive", legal: reviveActions() }, { kind: "revive" }, (action: ActionOf<"revive">) =>
        respond(action.partySlot, PartyOption.REVIVE),
      );
    } else if (partyUiMode === PartyUiMode.SELECT && this.inMysteryEncounter()) {
      const legal = mePokemonActions(args[3]);
      if (legal.length === 0 && phase.is("MysteryEncounterPhase")) {
        // No Pokémon can be picked (The GTS's "Trade an Item" with no held items): cancel, which is all the
        // player could do, and the menu shows again without that option.
        this.meDeadEnds = {
          phase,
          options: [...(this.meDeadEnds?.phase === phase ? this.meDeadEnds.options : []), this.meChosen],
        };
        this.meAnswered = null;
        respond(this.game.scene.getPlayerParty().length, PartyOption.CANCEL);
        return;
      }
      const decision: Decision = { kind: "mePokemon", encounterType: this.encounterType(), legal };
      this.raise(decision, { kind: "mePokemon", option: this.meChosen }, (action: ActionOf<"mePokemon">) => {
        this.mePickedIn = phase;
        respond(action.partySlot, PartyOption.SELECT);
      });
    }
  }

  private onConfirm(phase: Phase, config: ConfirmModeConfig): void {
    if (phase.is("SelectModifierPhase")) {
      // The "skip the reward?" prompt after skipReward.
      config.yesHandler();
    } else if (phase.is("CheckSwitchPhase")) {
      const fieldIndex: number = phase["fieldIndex"];
      const legal = [{ kind: "stay" as const }, ...switchActions()];
      const decision: Decision = { kind: "checkSwitch", fieldIndex, legal };
      this.raise(decision, { kind: "checkSwitch", fieldIndex }, (action: ActionOf<"stay" | "switch">) => {
        if (action.kind === "switch") {
          this.switchTo = action.partySlot;
          config.yesHandler();
        } else {
          config.noHandler();
        }
      });
    } else if (phase.is("LearnMovePhase")) {
      if (this.learning?.phase === phase && this.learning.forget == null) {
        // "Stop trying to teach the move?" after skipMove (only asked with the levelMoveConfirmation setting).
        this.learning = null;
        config.yesHandler();
        return;
      }
      const partySlot: number = phase["partyMemberIndex"];
      const moveId: MoveId = phase["moveId"];
      const decision: Decision = { kind: "learnMove", partySlot, moveId, legal: learnMoveActions() };
      this.raise(decision, { kind: "learnMove", partySlot, moveId }, (action: ActionOf<"learnMove" | "skipMove">) => {
        this.learning = { phase, forget: action.kind === "learnMove" ? action.forget : null };
        if (action.kind === "learnMove") {
          config.yesHandler();
        } else {
          config.noHandler();
        }
      });
    } else if (phase.is("EvolutionPhase")) {
      // "Pause evolutions?" after a cancelled evolution.
      config.noHandler();
    } else if (phase.is("EggLapsePhase")) {
      // "Skip hatching?": hatched Pokémon go to the starter box, not the party, so skip the animations.
      config.yesHandler();
    } else if (this.inMysteryEncounter() && config?.yesHandler != null) {
      // A yes/no prompt of an encounter (Clowning Around: take the clown's ability?).
      const labels = [i18next.t("menu:yes"), i18next.t("menu:no")];
      const decision: Decision = {
        kind: "meSubOption",
        encounterType: this.encounterType(),
        labels,
        legal: labels.map((_, index) => ({ kind: "meSubOption" as const, index })),
      };
      const input: StageInput = { kind: "meSubOption", option: this.meChosen, labels };
      this.raise(decision, input, (action: ActionOf<"meSubOption">) =>
        action.index === 0 ? config.yesHandler() : config.noHandler(),
      );
    }
  }

  /** The reward screen. Set with its callback when it opens, without it when a party screen returns to it. */
  private onRewardScreen(phase: SelectModifierPhase, args: any[]): void {
    if (args.length >= 3) {
      this.rewardScreen = { phase, args };
      this.raiseReward();
    } else {
      // The phase applies the item right after this mode change, then ends (reward) or stays (shop).
      this.raiseRewardAgainLater();
    }
  }

  private raiseReward(): void {
    const { phase, args } = this.rewardScreen!;
    const scene = this.game.scene;
    const typeOptions: ModifierTypeOption[] = args[1];
    const respond: ModifierSelectCallback = args[2];
    const shop = shopOptions();
    const rerollCost = phase.getRerollCost(scene.lockModifierTiers);

    const legal: ActionOf<"reward" | "buy" | "reroll" | "skipReward">[] = [];
    typeOptions.forEach((option, index) => {
      if (canTake(option.type)) {
        legal.push({ kind: "reward", index });
      }
    });
    shop.forEach((option, index) => {
      if (scene.money >= option.cost && canTake(option.type)) {
        legal.push({ kind: "buy", index });
      }
    });
    if (rerollCost >= 0 && scene.money >= rerollCost) {
      legal.push({ kind: "reroll" });
    }
    legal.push({ kind: "skipReward" });

    const decision: Decision = {
      kind: "reward",
      rewards: typeOptions.map(o => modifierId(o.type)),
      shop: shop.map(o => ({ item: modifierId(o.type), cost: o.cost })),
      rerollCost,
      money: scene.money,
      legal,
    };
    const input: StageInput = { kind: "reward", options: typeOptions, rerollCost };
    this.raise(decision, input, (action: ActionOf<"reward" | "buy" | "reroll" | "skipReward">) => {
      switch (action.kind) {
        case "reward":
          this.pickedItem = typeOptions[action.index].type;
          respond(1, action.index);
          break;
        case "buy": {
          // SelectModifierPhase.selectShopModifierOption: with two shop rows, rowCursor 3 is the first.
          const index = action.index;
          this.pickedItem = shop[index].type;
          if (shop.length <= SHOP_OPTIONS_ROW_LIMIT) {
            respond(2, index);
          } else if (index < SHOP_OPTIONS_ROW_LIMIT) {
            respond(3, index);
          } else {
            respond(2, index - SHOP_OPTIONS_ROW_LIMIT);
          }
          // An item with no target applies at once, and the screen stays with no new mode change.
          // (One with a target opens the party screen, and onRewardScreen raises it again on the way back.)
          if (!(shop[index].type instanceof PokemonModifierType)) {
            this.raiseRewardAgainLater();
          }
          break;
        }
        case "reroll":
          respond(0, 0);
          break;
        case "skipReward":
          // Negative cursors ask "skip the reward?"; onConfirm answers the CONFIRM that follows.
          respond(-1, -1);
          break;
      }
    });
  }

  /** Raise the reward screen again if it is still waiting once the current continuations have run. */
  private raiseRewardAgainLater(): void {
    const screen = this.rewardScreen;
    // Queued from a mode change's continuation, so it runs after the phase's continuation of the same change.
    Promise.resolve().then(() => {
      if (
        screen != null
        && this.running === screen.phase
        && this.decision == null
        && this.game.scene.ui.mode === UiMode.MODIFIER_SELECT
      ) {
        this.raiseReward();
      }
    });
  }

  private raiseItemTarget(partyUiMode: PartyUiMode, args: any[]): void {
    const [, , respond, selectFilter, moveSelectFilter] = args;
    const legal = itemTargetActions(partyUiMode, selectFilter, moveSelectFilter);
    const type = this.pickedItem!;
    const decision: Decision = { kind: "itemTarget", item: modifierId(type), legal };
    this.raise(decision, { kind: "itemTarget", type }, (action: ActionOf<"itemTarget">) => {
      switch (partyUiMode) {
        case PartyUiMode.SPLICE:
          respond(action.partySlot, action.fuseWith);
          break;
        case PartyUiMode.MOVE_MODIFIER:
          respond(action.partySlot, PartyOption.MOVE_1 + action.move!);
          break;
        case PartyUiMode.REMEMBER_MOVE_MODIFIER:
          respond(action.partySlot, action.move);
          break;
        case PartyUiMode.TM_MODIFIER:
          respond(action.partySlot, PartyOption.TEACH);
          break;
        default:
          respond(action.partySlot, PartyOption.APPLY);
      }
    });
  }

  private raiseBiome(config: OptionSelectModeConfig): void {
    const biomes = config.options.map(o => biomeByName(o.label));
    const legal = biomes.map(biome => ({ kind: "biome" as const, biome }));
    this.raise({ kind: "biome", biomes, legal }, { kind: "biome", choices: biomes }, (action: ActionOf<"biome">) => {
      config.options[biomes.indexOf(action.biome)].handler();
    });
  }

  /** Caught (or given) with a full party. The menu is Summary, Pokédex, Yes (release one), No. */
  private raisePartyFull(pokemon: Pokemon, config: OptionSelectModeConfig): void {
    const options = config.options;
    const decision: Decision = { kind: "partyFull", speciesId: pokemon.species.speciesId, legal: partyFullActions() };
    this.raise(decision, { kind: "catch", pokemon }, (action: ActionOf<"release" | "keepParty">) => {
      if (action.kind === "release") {
        this.releaseSlot = action.partySlot;
        options.at(-2)!.handler();
      } else {
        options.at(-1)!.handler();
      }
    });
  }

  /** Asked before the phase starts: once started, the evolution plays by itself. */
  private askEvolution(phase: EvolutionPhase): void {
    this.evolutionAsked = phase;
    const partySlot = this.game.scene.getPlayerParty().indexOf(phase["pokemon"]);
    const speciesId = phase["evolution"]!.speciesId;
    const legal: ActionOf<"evolve" | "cancelEvolution">[] = [{ kind: "evolve" }, { kind: "cancelEvolution" }];
    const decision: Decision = { kind: "evolution", partySlot, speciesId, legal };
    const input: StageInput = { kind: "evolution", partySlot, speciesId };
    this.raise(decision, input, (action: ActionOf<"evolve" | "cancelEvolution">) => {
      if (action.kind === "cancelEvolution") {
        this.evolutionCancelled = phase;
      }
    });
  }

  // #region mystery encounters

  /**
   * Yield to the event loop for a few ticks of the harness's clock (one per ms), which runs every pending
   * one-shot timer and short chains of them. (The clock also holds looping events, so it is never empty.)
   */
  private async drainTimers(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  private inMysteryEncounter(): boolean {
    return this.game.scene.currentBattle?.isBattleMysteryEncounter() ?? false;
  }

  private encounterType(): MysteryEncounterType {
    return this.game.scene.currentBattle.mysteryEncounter!.encounterType;
  }

  /** The encounter's option menu, read from its UI handler (which already checked the requirements). */
  private raiseMysteryEncounter(phase: MysteryEncounterPhase): void {
    const handler = this.game.scene.ui.getHandler() as MysteryEncounterUiHandler;
    const options: MysteryEncounterOption[] = handler["encounterOptions"];
    const optionsMeetsReqs: boolean[] = handler["optionsMeetsReqs"];
    const view = meOptions(options, optionsMeetsReqs);
    const encounter = this.game.scene.currentBattle.mysteryEncounter!;
    const { intro, encounterOptionsDialogue: box } = encounter.dialogue;
    const followUp = phase.optionSelectSettings != null;
    const decision: Decision = {
      kind: "mysteryEncounter",
      encounterType: encounter.encounterType,
      tier: encounter.encounterTier,
      followUp,
      intro: followUp ? [] : (intro ?? []).map(d => encounterText(d.text)),
      title: encounterText(box?.title),
      description: encounterText(box?.description),
      query: encounterText(box?.query),
      options: view,
      legal: meOptionActions(view).filter(
        a => !(this.meDeadEnds?.phase === phase && this.meDeadEnds.options.includes(a.index)),
      ),
    };
    const input: StageInput = { kind: "mysteryEncounter", options, optionsMeetsReqs, followUp };
    this.raise(decision, input, (action: ActionOf<"meOption">) => {
      this.meAnswered = phase;
      this.meChosen = action.index;
      phase.handleOptionSelect(options[action.index], action.index);
    });
  }

  /**
   * An option menu during an encounter: the full-party menu for a gift Pokémon, or a follow-up menu. The
   * "Cancel" that ends a menu after a Pokémon pick only goes back to the encounter menu, so it is left out.
   */
  private onEncounterMenu(phase: Phase, config: OptionSelectModeConfig): void {
    const options = config.options;
    if (options.length === 4 && options[0].label === i18next.t("partyUiHandler:summary")) {
      this.raisePartyFull(this.shownPokemon!, config);
      return;
    }
    const afterPick = this.mePickedIn === phase;
    this.mePickedIn = null;
    const cancel = afterPick && options.length > 1 && options.at(-1)!.label === i18next.t("menu:cancel") ? 1 : 0;
    const labels = options.map(o => o.label);
    const decision: Decision = {
      kind: "meSubOption",
      encounterType: this.encounterType(),
      labels,
      legal: options.slice(0, options.length - cancel).map((_, index) => ({ kind: "meSubOption" as const, index })),
    };
    this.raise(decision, { kind: "meSubOption", option: this.meChosen, labels }, (action: ActionOf<"meSubOption">) => {
      if (afterPick && action.index === options.length - 1) {
        // The only entry was Cancel: the encounter menu shows again.
        this.meAnswered = null;
      }
      options[action.index].handler();
    });
  }

  // #endregion
}
