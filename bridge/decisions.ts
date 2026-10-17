// Decision points and their legal actions (issue #7). The driver (bridge/driver.ts) raises a Decision
// whenever the game waits for the player; this file defines what each decision offers and computes
// its legal actions from the game state, using the same checks the game applies when the player
// confirms a choice in the UI. Legality may use hidden state (e.g. an enemy's trapping ability):
// it mirrors what the game would accept, not what the player can see.

import { MAX_TERAS_PER_ARENA } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { getDailyEventSeedBoss } from "#data/daily-run";
import { isDailyFinalBoss } from "#data/daily-seed-utils";
import { AbilityId } from "#enums/ability-id";
import { BattleType } from "#enums/battle-type";
import type { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MysteryEncounterMode } from "#enums/mystery-encounter-mode";
import { PartyUiMode } from "#enums/party-ui-mode";
import { PokeballType } from "#enums/pokeball";
import type { SpeciesId } from "#enums/species-id";
import type { PlayerPokemon } from "#field/pokemon";
import { HealShopCostModifier } from "#modifiers/modifier";
import {
  FusePokemonModifierType,
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierType,
  PokemonModifierType,
  PokemonMoveModifierType,
  RememberMoveModifierType,
  TmModifierType,
} from "#modifiers/modifier-type";
import { getMoveTargets } from "#moves/move-utils";
import type { PokemonMoveSelectFilter, PokemonSelectFilter } from "#ui/party-ui-handler";
import { getBiomeName, NumberHolder } from "#utils/common";
import { canTerastallize } from "#utils/pokemon-utils";

/** An answer to a {@linkcode Decision}. Party slots index `globalScene.getPlayerParty()`. */
export type Action =
  // command
  | { kind: "move"; slot: number; tera?: boolean } // slot 0 means Struggle when no move is usable
  | { kind: "switch"; partySlot: number } // also answers switch and checkSwitch
  | { kind: "ball"; ball: PokeballType }
  | { kind: "run" }
  // target
  | { kind: "target"; target: BattlerIndex }
  // checkSwitch
  | { kind: "stay" }
  // reward
  | { kind: "reward"; index: number } // a free reward, by index in `rewards`
  | { kind: "buy"; index: number } // a shop item, by index in `shop`
  | { kind: "reroll" }
  | { kind: "skipReward" }
  // itemTarget. `move` is a move slot (PP items) or an index into `getLearnableLevelMoves()`
  // (Memory Mushroom); `fuseWith` is the second Pokémon for DNA Splicers.
  | { kind: "itemTarget"; partySlot: number; move?: number; fuseWith?: number }
  // learnMove
  | { kind: "learnMove"; forget: number }
  | { kind: "skipMove" }
  // biome
  | { kind: "biome"; biome: BiomeId }
  // evolution
  | { kind: "evolve" }
  | { kind: "cancelEvolution" }
  // partyFull: release a party member to keep the caught Pokémon, or let the caught one go
  | { kind: "release"; partySlot: number }
  | { kind: "keepParty" }
  // revive (Revival Blessing)
  | { kind: "revive"; partySlot: number };

/** The actions of the given kinds. */
export type ActionOf<K extends Action["kind"]> = Extract<Action, { kind: K }>;

/** A shop item on the reward screen. */
export interface ShopItem {
  /** Modifier type id, e.g. `"POTION"`. */
  item: string;
  cost: number;
}

/** A point where the game waits for the player, with every action the game would accept there. */
export type Decision =
  /** Choose what an active Pokémon does this turn. */
  | { kind: "command"; fieldIndex: number; legal: ActionOf<"move" | "switch" | "ball" | "run">[] }
  /** Choose the target of a single-target move (doubles). */
  | { kind: "target"; fieldIndex: number; moveId: MoveId; legal: ActionOf<"target">[] }
  /** Send in a Pokémon after a faint, or after a move/ability that forces a switch (U-turn, Baton Pass). */
  | { kind: "switch"; fieldIndex: number; legal: ActionOf<"switch">[] }
  /** "Will you switch Pokémon?" at the start of a wave, in the Switch battle style. */
  | { kind: "checkSwitch"; fieldIndex: number; legal: ActionOf<"stay" | "switch">[] }
  /** The reward screen after a wave. `rewards` and `shop` are modifier type ids. */
  | {
      kind: "reward";
      rewards: string[];
      shop: ShopItem[];
      rerollCost: number;
      money: number;
      legal: ActionOf<"reward" | "buy" | "reroll" | "skipReward">[];
    }
  /** The party screen after picking a reward or shop item that applies to one Pokémon (and maybe a move). */
  | { kind: "itemTarget"; item: string; legal: ActionOf<"itemTarget">[] }
  /** A Pokémon with four moves wants to learn `moveId`. */
  | { kind: "learnMove"; partySlot: number; moveId: MoveId; legal: ActionOf<"learnMove" | "skipMove">[] }
  /** Choose the next biome (needs a Map). */
  | { kind: "biome"; biomes: BiomeId[]; legal: ActionOf<"biome">[] }
  /** A Pokémon is about to evolve into `speciesId`. */
  | { kind: "evolution"; partySlot: number; speciesId: SpeciesId; legal: ActionOf<"evolve" | "cancelEvolution">[] }
  /** A Pokémon (`speciesId`) was caught with a full party. */
  | { kind: "partyFull"; speciesId: SpeciesId; legal: ActionOf<"release" | "keepParty">[] }
  /** Revival Blessing: choose a fainted party member to revive. */
  | { kind: "revive"; legal: ActionOf<"revive">[] }
  /** The run is over (`GameOverPhase` is next). Nothing is legal. */
  | { kind: "gameOver"; victory: boolean; legal: never[] };

/** Whether two actions are the same (an absent `tera` equals `tera: false`). */
export function sameAction(a: Action, b: Action): boolean {
  const key = (x: Action) =>
    JSON.stringify(
      Object.entries(x)
        .filter(([, v]) => v !== undefined && v !== false)
        .sort(([k1], [k2]) => k1.localeCompare(k2)),
    );
  return key(a) === key(b);
}

// #region battle

/** Party slots that can be sent into battle: benched, not fainted, and allowed by the run's challenges. */
function benchSlots(): number[] {
  const party = globalScene.getPlayerParty();
  const battlerCount = globalScene.currentBattle.getBattlerCount();
  return party
    .map((_, i) => i)
    .filter(i => i >= battlerCount && party[i].isAllowedInBattle() && !party[i].isOnField());
}

/** Legal actions for {@linkcode Decision} `command`, mirroring `CommandPhase.handleCommand`. */
export function commandActions(fieldIndex: number): ActionOf<"move" | "switch" | "ball" | "run">[] {
  const battle = globalScene.currentBattle;
  const pokemon = globalScene.getPlayerField()[fieldIndex];
  const moveset = pokemon.getMoveset();
  const usable = moveset.map((_, i) => i).filter(i => moveset[i].isUsable(pokemon, false, true)[0]);
  // With no usable move, any FIGHT command becomes Struggle.
  const moves: ActionOf<"move">[] = (usable.length > 0 ? usable : [0]).map(slot => ({ kind: "move", slot }));
  if (canTera(pokemon, fieldIndex)) {
    moves.push(...moves.map(m => ({ ...m, tera: true })));
  }
  const actions: ActionOf<"move" | "switch" | "ball" | "run">[] = moves;

  // isTrapped also covers Commander.
  if (!pokemon.isTrapped()) {
    const ally = battle.turnCommands[fieldIndex === 0 ? 1 : 0];
    for (const partySlot of benchSlots()) {
      if (!(ally?.command === Command.POKEMON && ally.cursor === partySlot)) {
        actions.push({ kind: "switch", partySlot });
      }
    }
  }
  for (const ball of [
    PokeballType.POKEBALL,
    PokeballType.GREAT_BALL,
    PokeballType.ULTRA_BALL,
    PokeballType.ROGUE_BALL,
    PokeballType.MASTER_BALL,
  ]) {
    if (globalScene.pokeballCounts[ball] > 0 && canThrowBall(ball)) {
      actions.push({ kind: "ball", ball });
    }
  }
  if (canRun(pokemon)) {
    actions.push({ kind: "run" });
  }
  return actions;
}

/** `CommandUiHandler.canTera`: the player has a Tera Orb and no tera used or planned this wave. */
function canTera(pokemon: PlayerPokemon, fieldIndex: number): boolean {
  const planned = fieldIndex > 0 && globalScene.currentBattle.preTurnCommands[0]?.command === Command.TERA ? 1 : 0;
  return canTerastallize(pokemon) && globalScene.arena.playerTerasUsed + planned < MAX_TERAS_PER_ARENA;
}

/** `CommandPhase.checkCanUseBall` and `handleBallCommand`, without their messages. */
function canThrowBall(ball: PokeballType): boolean {
  const { arena, currentBattle, gameData, gameMode } = globalScene;
  const targets = globalScene.getEnemyField().filter(p => p.isActive(true));
  if (targets.length !== 1) {
    return false;
  }
  const isClassicFinalBoss = gameMode.isBattleClassicFinalBoss(currentBattle.waveIndex);
  const isCatchableDailyBoss = isDailyFinalBoss() && (getDailyEventSeedBoss()?.catchable ?? false);
  if (currentBattle.battleType === BattleType.TRAINER) {
    return false;
  }
  if (currentBattle.isBattleMysteryEncounter() && !currentBattle.mysteryEncounter!.catchAllowed) {
    return false;
  }
  if (arena.biomeId === BiomeId.END && currentBattle.battleType === BattleType.WILD) {
    const isEndlessMinorBoss = gameMode.isEndlessMinorBoss(currentBattle.waveIndex);
    const isFullFreshStart = gameMode.isFullFreshStartChallenge();
    const someUncaught = targets.some(p => !gameData.dexData[p.species.speciesId].caughtAttr);
    const missingMultipleStarters =
      gameData.getStarterCount(d => !!d.caughtAttr) < speciesDataRegistry.getAllStarters().length - 1;
    if (
      (gameMode.isClassic && !isClassicFinalBoss && someUncaught)
      || (isFullFreshStart && !isClassicFinalBoss)
      || (gameMode.isEndless && !isEndlessMinorBoss)
      || (gameMode.isClassic && isClassicFinalBoss && missingMultipleStarters)
      || (isFullFreshStart && isClassicFinalBoss)
      || (gameMode.isEndless && isEndlessMinorBoss)
      || (gameMode.isDaily && !isCatchableDailyBoss)
    ) {
      return false;
    }
  }
  const target = targets[0];
  if (target.isBoss() && target.bossSegmentIndex >= 1 && !target.hasAbility(AbilityId.WONDER_GUARD, false, true)) {
    if (isClassicFinalBoss) {
      return ball === PokeballType.MASTER_BALL && !gameMode.hasAnyChallenges();
    }
    return ball === PokeballType.MASTER_BALL && !isCatchableDailyBoss;
  }
  return true;
}

/** `CommandPhase.handleRunCommand`, without its messages. */
function canRun(pokemon: PlayerPokemon): boolean {
  const { currentBattle, arena } = globalScene;
  const encounter = currentBattle.mysteryEncounter;
  return (
    arena.biomeId !== BiomeId.END
    && (encounter?.fleeAllowed ?? true)
    && currentBattle.battleType !== BattleType.TRAINER
    && encounter?.encounterMode !== MysteryEncounterMode.TRAINER_BATTLE
    && !pokemon.isTrapped()
  );
}

/** The targets a move can be aimed at, and whether it hits all of them at once (no choice to make). */
export function moveTargets(fieldIndex: number, moveId: MoveId): { targets: BattlerIndex[]; multiple: boolean } {
  return getMoveTargets(globalScene.getPlayerField()[fieldIndex], moveId);
}

/** Legal actions for {@linkcode Decision} `switch`. */
export function switchActions(): ActionOf<"switch">[] {
  return benchSlots().map(partySlot => ({ kind: "switch", partySlot }));
}

// #endregion
// #region rewards

/**
 * A modifier type's key, e.g. `"POTION"`. Shop items are built without their `id`, so fall back to the
 * key at the end of their locale key (`"modifierType:ModifierType.POTION"`).
 */
export function modifierId(type: ModifierType): string {
  return type.id ?? type.localeKey.split(".").at(-1)!;
}

/** The shop items of the reward screen, if this mode has a shop. Costs include Black Sludge. */
export function shopOptions(): { type: ModifierType; cost: number }[] {
  if (!globalScene.gameMode.getShopStatus()) {
    return [];
  }
  return getPlayerShopModifierTypeOptionsForWave(
    globalScene.currentBattle.waveIndex,
    globalScene.getWaveMoneyAmount(1),
  ).map(option => {
    const cost = new NumberHolder(option.cost);
    globalScene.applyModifier(HealShopCostModifier, true, cost);
    return { type: option.type, cost: cost.value };
  });
}

/** The party screen `SelectModifierPhase` opens for a modifier type, as in its `openModifierMenu`. */
export function partyUiModeFor(type: PokemonModifierType): PartyUiMode {
  if (type instanceof FusePokemonModifierType) {
    return PartyUiMode.SPLICE;
  }
  if (type instanceof PokemonMoveModifierType) {
    return PartyUiMode.MOVE_MODIFIER;
  }
  if (type instanceof TmModifierType) {
    return PartyUiMode.TM_MODIFIER;
  }
  if (type instanceof RememberMoveModifierType) {
    return PartyUiMode.REMEMBER_MOVE_MODIFIER;
  }
  return PartyUiMode.MODIFIER;
}

/** Legal actions for {@linkcode Decision} `itemTarget`, from the party screen's mode and filters. */
export function itemTargetActions(
  mode: PartyUiMode,
  selectFilter: PokemonSelectFilter | undefined,
  moveSelectFilter: PokemonMoveSelectFilter | undefined,
): ActionOf<"itemTarget">[] {
  const party = globalScene.getPlayerParty();
  const slots = party.map((_, i) => i).filter(i => (selectFilter?.(party[i]) ?? null) === null);
  return slots.flatMap((partySlot): ActionOf<"itemTarget">[] => {
    const pokemon = party[partySlot];
    switch (mode) {
      case PartyUiMode.SPLICE:
        return slots.filter(j => j !== partySlot).map(fuseWith => ({ kind: "itemTarget", partySlot, fuseWith }));
      case PartyUiMode.MOVE_MODIFIER:
        return pokemon.moveset
          .map((_, move) => move)
          .filter(move => (moveSelectFilter?.(pokemon.moveset[move]) ?? null) === null)
          .map(move => ({ kind: "itemTarget", partySlot, move }));
      case PartyUiMode.REMEMBER_MOVE_MODIFIER:
        return pokemon.getLearnableLevelMoves().map((_, move) => ({ kind: "itemTarget", partySlot, move }));
      default:
        return [{ kind: "itemTarget", partySlot }];
    }
  });
}

/** Whether picking this modifier type can succeed: it needs no target, or some Pokémon can take it. */
export function canTake(type: ModifierType): boolean {
  if (!(type instanceof PokemonModifierType)) {
    return true;
  }
  const moveSelectFilter = type instanceof PokemonMoveModifierType ? type.moveSelectFilter : undefined;
  return itemTargetActions(partyUiModeFor(type), type.selectFilter, moveSelectFilter).length > 0;
}

// #endregion
// #region other

/** Legal actions for {@linkcode Decision} `learnMove`. */
export function learnMoveActions(): ActionOf<"learnMove" | "skipMove">[] {
  return [
    { kind: "learnMove", forget: 0 },
    { kind: "learnMove", forget: 1 },
    { kind: "learnMove", forget: 2 },
    { kind: "learnMove", forget: 3 },
    { kind: "skipMove" },
  ];
}

/** The biome an option of `SelectBiomePhase`'s menu stands for (the menu only keeps its name). */
export function biomeByName(label: string): BiomeId {
  const biome = (Object.values(BiomeId) as BiomeId[]).find(b => getBiomeName(b) === label);
  if (biome === undefined) {
    throw new Error(`No biome is named "${label}"`);
  }
  return biome;
}

/** Legal actions for {@linkcode Decision} `partyFull`. */
export function partyFullActions(): ActionOf<"release" | "keepParty">[] {
  return globalScene
    .getPlayerParty()
    .map((_, partySlot): ActionOf<"release" | "keepParty"> => ({ kind: "release", partySlot }))
    .concat({ kind: "keepParty" });
}

/** Legal actions for {@linkcode Decision} `revive`. */
export function reviveActions(): ActionOf<"revive">[] {
  const party = globalScene.getPlayerParty();
  return party.map((_, i) => i).filter(i => party[i].isFainted()).map(partySlot => ({ kind: "revive", partySlot }));
}

// #endregion
