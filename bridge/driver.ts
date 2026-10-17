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
// Each decision comes with its observation (issue #10): raise() takes the StageInput for the decision,
// built from what the UI mode passed, and observe() turns it into the fair-information observation
// (bridge/observation.ts) with the driver's RevealTracker. A policy gets only that observation and the
// legal actions, never the scene. A new decision point passes its StageInput to raise() like the others.

import type { Phase } from "#app/phase";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { PartyUiMode } from "#enums/party-ui-mode";
import { UiMode } from "#enums/ui-mode";
import { type ModifierType, type ModifierTypeOption, PokemonModifierType } from "#modifiers/modifier-type";
import type { CommandPhase } from "#phases/command-phase";
import type { EvolutionPhase } from "#phases/evolution-phase";
import type { ModifierSelectCallback, SelectModifierPhase } from "#phases/select-modifier-phase";
import type { GameManager } from "#test/framework/game-manager";
import type { ConfirmModeConfig, OptionSelectModeConfig } from "#types/ui-types";
import type { EvolutionSceneUiHandler } from "#ui/evolution-scene-ui-handler";
import { SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import { PartyOption } from "#ui/party-ui-handler";
import {
  type Action,
  type ActionOf,
  biomeByName,
  canTake,
  commandActions,
  type Decision,
  itemTargetActions,
  learnMoveActions,
  modifierId,
  moveTargets,
  partyFullActions,
  reviveActions,
  sameAction,
  shopOptions,
  switchActions,
} from "./decisions";
import { buildObservation, type Observation, type StageInput } from "./observation";
import { RevealTracker } from "./reveal-tracker";

export type { Action, ActionOf, Decision, ShopItem } from "./decisions";

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

  /** Enemy moves and abilities revealed so far this run, for the observations. */
  public readonly tracker: RevealTracker;

  /** Number of TurnEndPhases started. */
  public turns = 0;
  /** Number of phases started. */
  public phasesRun = 0;

  /**
   * Take over the game's phase loop. Call when no phase is running, e.g. right after
   * `classicMode.runToSummon()`, which stops after EncounterPhase ends.
   */
  constructor(private readonly game: GameManager) {
    this.tracker = new RevealTracker(game.scene);
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
      const pm = this.game.scene.phaseManager;
      if (this.running == null) {
        const phase = pm.getCurrentPhase();
        if (phase.is("GameOverPhase")) {
          // Not started, so the game never reaches the title screen.
          return { kind: "gameOver", victory: phase["isVictory"], legal: [] };
        }
        if (phase.is("EvolutionPhase") && phase !== this.evolutionAsked && phase["canCancel"] && phase.validate()) {
          this.askEvolution(phase);
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
        this.phasesRun++;
        if (this.running.is("TurnEndPhase")) {
          this.turns++;
        }
        this.running.start();
      }
      await prom;
    }
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
    answer(action);
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

  /** Stop tracking reveals. Call when done with the run. */
  dispose(): void {
    this.tracker.dispose();
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
          this.raisePartyFull(phase["fieldIndex"], args[0]);
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

  /** Make `decision` the current one. `input` describes it for {@linkcode observe}. */
  private raise(decision: Decision, input: StageInput, answer: Answer): void {
    this.decision = decision;
    this.input = input;
    this.answer = answer;
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
    } else if (phase.is("AttemptCapturePhase") && partyUiMode === PartyUiMode.RELEASE && this.releaseSlot != null) {
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

  /** Caught with a full party. The menu is Summary, Pokédex, Yes (release one), No. */
  private raisePartyFull(fieldIndex: number, config: OptionSelectModeConfig): void {
    const pokemon = this.game.scene.getEnemyField()[fieldIndex];
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
}
