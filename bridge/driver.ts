// Headless driver: steps pokerogue's phase queue directly instead of through the test harness's
// PhaseInterceptor, which polls every 50 ms for an async phase to finish (issue #2).
//
// Two hooks replace the polling:
//   - phaseManager.startCurrentPhase (called when a phase ends) records the end instead of starting
//     the next phase, so the driver decides when each phase starts.
//   - ui.setModeInternal reports UI modes that wait for player input. These are the decision points.
// Both wake next(), which awaits only while a phase is running asynchronously.

import type { Phase } from "#app/phase";
import type { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import type { ModifierSelectCallback } from "#phases/select-modifier-phase";
import type { GameManager } from "#test/framework/game-manager";
import type { ConfirmModeConfig } from "#types/ui-types";
import { PartyOption } from "#ui/party-ui-handler";

/** A point where the game waits for the player. */
export type Decision =
  | { kind: "command"; fieldIndex: number }
  | { kind: "target"; fieldIndex: number; moveId: MoveId }
  | { kind: "switch"; fieldIndex: number }
  | { kind: "reward" }
  | { kind: "gameOver" };

/** An answer to a {@linkcode Decision}. Only the actions the issue #2 smoke run needs; the rest is issue #7. */
export type Action =
  | { kind: "move"; slot: number }
  | { kind: "target"; target: BattlerIndex }
  | { kind: "switch"; partySlot: number }
  | { kind: "skipReward" };

type SetModeInternal = (
  mode: UiMode,
  clear: boolean,
  force: boolean,
  chain: boolean,
  args: any[],
) => Promise<void>;

export class Driver {
  /** The current decision, set by the UI hook and cleared by {@linkcode act}. */
  private decision: Decision | null = null;
  /** Callback from the UI mode that raised {@linkcode decision}, used by {@linkcode act}. */
  private respond: ((...args: any[]) => unknown) | null = null;
  /** The phase the driver started that has not ended yet. */
  private running: Phase | null = null;
  /** Resolves the promise next() is awaiting, if any. */
  private wake: (() => void) | null = null;

  /** Number of TurnEndPhases started. */
  public turns = 0;
  /** Number of phases started. */
  public phasesRun = 0;

  /**
   * Take over the game's phase loop. Call when no phase is running, e.g. right after
   * `classicMode.runToSummon()`, which stops after EncounterPhase ends.
   */
  constructor(private readonly game: GameManager) {
    const ui = game.scene.ui as unknown as { setModeInternal: SetModeInternal };

    game.scene.phaseManager["startCurrentPhase"] = () => {
      this.running = null;
      this.wake?.();
    };

    const setModeInternal = ui.setModeInternal;
    ui.setModeInternal = (mode, clear, force, chain, args) => {
      const done = setModeInternal.call(ui, mode, clear, force, chain, args);
      // A mode is only ready for input once its handler is shown, so act after the transition.
      done.then(() => this.onModeSet(mode, args));
      return done;
    };
  }

  /** Run phases until the game waits for the player or the run ends, and return that decision. */
  async next(): Promise<Decision> {
    for (;;) {
      if (this.decision != null) {
        return this.decision;
      }
      if (this.game.isCurrentPhase("GameOverPhase")) {
        return { kind: "gameOver" };
      }
      this.wake = null;
      const prom = new Promise<void>(resolve => {
        this.wake = resolve;
      });
      if (this.running == null) {
        this.running = this.game.scene.phaseManager.getCurrentPhase();
        this.phasesRun++;
        if (this.running.is("TurnEndPhase")) {
          this.turns++;
        }
        this.running.start();
      }
      await prom;
    }
  }

  /** Answer the current decision. The game resumes on the next call to {@linkcode next}. */
  act(action: Action): void {
    const decision = this.decision;
    const respond = this.respond;
    if (decision == null) {
      throw new Error("Driver.act called with no pending decision");
    }
    // Clear first: answering can raise the next decision synchronously.
    this.decision = null;
    this.respond = null;

    switch (`${decision.kind}/${action.kind}`) {
      case "command/move": {
        const phase =
          this.game.scene.phaseManager.getCurrentPhase() as CommandPhase;
        // On an unusable move the phase shows a message and asks again, which raises a new decision.
        phase.handleCommand(
          Command.FIGHT,
          (action as { slot: number }).slot,
          MoveUseMode.NORMAL,
        );
        break;
      }
      case "target/target":
        respond!([(action as { target: BattlerIndex }).target]);
        break;
      case "switch/switch":
        respond!(
          (action as { partySlot: number }).partySlot,
          PartyOption.SEND_OUT,
        );
        break;
      case "reward/skipReward":
        // Negative cursors ask "skip the reward?"; onModeSet answers the CONFIRM that follows.
        (respond as ModifierSelectCallback)(-1, -1);
        break;
      default:
        this.decision = decision;
        this.respond = respond;
        throw new Error(
          `Action ${action.kind} does not answer decision ${decision.kind}`,
        );
    }
  }

  /** Turn a finished UI mode change into a decision if the current phase is now waiting for input. */
  private onModeSet(mode: UiMode, args: any[]): void {
    const pm = this.game.scene.phaseManager;
    // Skip modes that were replaced while transitioning in.
    if (this.game.scene.ui.mode !== mode) {
      return;
    }
    const phase = pm.getCurrentPhase();
    if (
      (mode === UiMode.COMMAND || mode === UiMode.FIGHT) &&
      phase.is("CommandPhase")
    ) {
      this.raise({ kind: "command", fieldIndex: phase.getFieldIndex() });
    } else if (mode === UiMode.TARGET_SELECT && phase.is("SelectTargetPhase")) {
      this.raise(
        { kind: "target", fieldIndex: args[0], moveId: args[1] },
        args[2],
      );
    } else if (mode === UiMode.PARTY && phase.is("SwitchPhase")) {
      this.raise({ kind: "switch", fieldIndex: args[1] }, args[2]);
    } else if (
      mode === UiMode.MODIFIER_SELECT &&
      phase.is("SelectModifierPhase")
    ) {
      this.raise({ kind: "reward" }, args[2]);
    } else if (mode === UiMode.CONFIRM && phase.is("SelectModifierPhase")) {
      // The "skip the reward?" prompt after skipReward. Not a decision of its own.
      (args[0] as ConfirmModeConfig).yesHandler();
    }
  }

  private raise(decision: Decision, respond: Driver["respond"] = null): void {
    this.decision = decision;
    this.respond = respond;
    this.wake?.();
  }
}
