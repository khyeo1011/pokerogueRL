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

import type { Phase } from "#app/phase";
import { Command } from "#enums/command";
import { MoveUseMode } from "#enums/move-use-mode";
import type { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PartyUiMode } from "#enums/party-ui-mode";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { Pokemon } from "#field/pokemon";
import { type ModifierTypeOption, PokemonModifierType } from "#modifiers/modifier-type";
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
  shopOptions,
  switchActions,
} from "./decisions";

export type { Action, ActionOf, Decision, MeOption, ShopItem } from "./decisions";

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
  /** The modifier type id last picked on the reward screen, for the itemTarget decision that follows. */
  private pickedItem = "";
  /** The MysteryEncounterPhase whose menu was answered: its menu shows again while the option runs. */
  private meAnswered: Phase | null = null;
  /** The phase in which mePokemon was last answered: a menu that follows in it is the second pick. */
  private mePickedIn: Phase | null = null;
  /** The last Pokémon shown in the info box (an encounter's gift Pokémon, for partyFull). */
  private shownPokemon: Pokemon | null = null;
  /** The NewBattlePhase after an encounter for which pending timers were run. */
  private drained: Phase | null = null;
  /** Set when the game asks for something the driver can't answer; next() throws it. */
  private failure: Error | null = null;

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

    const info = game.scene.pokemonInfoContainer;
    const show = info.show;
    info.show = (pokemon: Pokemon, ...rest: any[]) => {
      this.shownPokemon = pokemon;
      return show.call(info, pokemon, ...rest);
    };
  }

  /**
   * Run phases until the game waits for the player or the run ends, and return that decision. Throws if
   * the game waits for a choice that has no legal action.
   */
  async next(): Promise<Decision> {
    for (;;) {
      if (this.failure != null) {
        throw this.failure;
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
    answer(action);
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
          this.raisePartyFull(this.game.scene.getEnemyField()[phase["fieldIndex"]].species.speciesId, args[0]);
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

  private raise(decision: Decision, answer: Answer): void {
    if (decision.legal.length === 0) {
      // Nothing could answer it, so fail now instead of waiting forever.
      const phase = this.game.scene.phaseManager.getCurrentPhase().phaseName;
      this.failure = new Error(`Decision ${decision.kind} in ${phase} has no legal action`);
    } else {
      this.decision = decision;
      this.answer = answer;
    }
    this.wake?.();
  }

  private raiseCommand(phase: CommandPhase): void {
    const fieldIndex = phase.getFieldIndex();
    const decision: Decision = { kind: "command", fieldIndex, legal: commandActions(fieldIndex) };
    this.raise(decision, (action: ActionOf<"move" | "switch" | "ball" | "run">) => {
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
    this.raise({ kind: "target", fieldIndex, moveId, legal }, (action: ActionOf<"target">) => respond([action.target]));
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
      this.raise({ kind: "switch", fieldIndex, legal: switchActions() }, (action: ActionOf<"switch">) =>
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
      this.raise({ kind: "revive", legal: reviveActions() }, (action: ActionOf<"revive">) =>
        respond(action.partySlot, PartyOption.REVIVE),
      );
    } else if (partyUiMode === PartyUiMode.SELECT && this.inMysteryEncounter()) {
      const decision: Decision = { kind: "mePokemon", encounterType: this.encounterType(), legal: mePokemonActions(args[3]) };
      this.raise(decision, (action: ActionOf<"mePokemon">) => {
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
      const legal = [{ kind: "stay" as const }, ...switchActions()];
      const decision: Decision = { kind: "checkSwitch", fieldIndex: phase["fieldIndex"], legal };
      this.raise(decision, (action: ActionOf<"stay" | "switch">) => {
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
      const decision: Decision = {
        kind: "learnMove",
        partySlot: phase["partyMemberIndex"],
        moveId: phase["moveId"],
        legal: learnMoveActions(),
      };
      this.raise(decision, (action: ActionOf<"learnMove" | "skipMove">) => {
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
      this.raise(decision, (action: ActionOf<"meSubOption">) =>
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
    this.raise(decision, (action: ActionOf<"reward" | "buy" | "reroll" | "skipReward">) => {
      switch (action.kind) {
        case "reward":
          this.pickedItem = modifierId(typeOptions[action.index].type);
          respond(1, action.index);
          break;
        case "buy": {
          // SelectModifierPhase.selectShopModifierOption: with two shop rows, rowCursor 3 is the first.
          const index = action.index;
          this.pickedItem = modifierId(shop[index].type);
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
    this.raise({ kind: "itemTarget", item: this.pickedItem, legal }, (action: ActionOf<"itemTarget">) => {
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
    this.raise({ kind: "biome", biomes, legal }, (action: ActionOf<"biome">) => {
      config.options[biomes.indexOf(action.biome)].handler();
    });
  }

  /** Caught (or given) with a full party. The menu is Summary, Pokédex, Yes (release one), No. */
  private raisePartyFull(speciesId: SpeciesId, config: OptionSelectModeConfig): void {
    const options = config.options;
    const decision: Decision = { kind: "partyFull", speciesId, legal: partyFullActions() };
    this.raise(decision, (action: ActionOf<"release" | "keepParty">) => {
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
    const decision: Decision = {
      kind: "evolution",
      partySlot: this.game.scene.getPlayerParty().indexOf(phase["pokemon"]),
      speciesId: phase["evolution"]!.speciesId,
      legal: [{ kind: "evolve" }, { kind: "cancelEvolution" }],
    };
    this.raise(decision, (action: ActionOf<"evolve" | "cancelEvolution">) => {
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
    const view = meOptions(options, handler["optionsMeetsReqs"]);
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
      legal: meOptionActions(view),
    };
    this.raise(decision, (action: ActionOf<"meOption">) => {
      this.meAnswered = phase;
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
      this.raisePartyFull(this.shownPokemon!.species.speciesId, config);
      return;
    }
    const afterPick = this.mePickedIn === phase;
    this.mePickedIn = null;
    const cancel = afterPick && options.length > 1 && options.at(-1)!.label === i18next.t("menu:cancel") ? 1 : 0;
    const decision: Decision = {
      kind: "meSubOption",
      encounterType: this.encounterType(),
      labels: options.map(o => o.label),
      legal: options.slice(0, options.length - cancel).map((_, index) => ({ kind: "meSubOption" as const, index })),
    };
    this.raise(decision, (action: ActionOf<"meSubOption">) => {
      if (afterPick && action.index === options.length - 1) {
        // The only entry was Cancel: the encounter menu shows again.
        this.meAnswered = null;
      }
      options[action.index].handler();
    });
  }

  // #endregion
}
