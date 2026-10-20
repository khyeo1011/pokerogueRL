// Fixed-size encoding for MaskablePPO (issue #16): the observation (bridge/observation.ts) as a vector of
// OBS_DIM numbers, and every action of every decision (bridge/decisions.ts) as an index in [0, N_ACTIONS).
// It reads only the Observation and the legal actions, so it knows no more than the policy may.
//
// Observation vector, in order: a one-hot of the stage, the stage-specific part, the run, the six party
// slots, then the battle. Every part has a fixed width: lists fill fixed slots and are padded with zeros.
//
// Conventions:
// - ID slots hold `id + 1`, and 0 for none or unknown (a padded slot, an unrevealed move). The network
//   embeds them by vocabulary (#17). Item keys are numbered by their sorted order in `modifierTypes`.
// - Values that may be unknown (enemy moves and ability) get a flag saying whether they are known, next to
//   a neutral value, so "unknown" never looks like a real value.
// - Other numbers are scaled to roughly [0, 1].
//
// Action space: one block of slots per action kind (ACTION_BLOCKS), the same at every stage, so stages
// handed to the network later (#22-#26) use slots that are already there. The mask allows exactly the
// legal actions; a legal action past a cap (e.g. a 9th reward option) has no slot and is left out.

import { modifierTypes } from "#data/data-lists";
import { ArenaTagType } from "#enums/arena-tag-type";
import { BiomeId } from "#enums/biome-id";
import { MysteryEncounterTier } from "#enums/mystery-encounter-tier";
import { PokeballType } from "#enums/pokeball";
import type { Action } from "./decisions";
import {
  type BattleObs,
  type EnemyPokemonObs,
  type FieldEffectObs,
  type FieldObs,
  type ItemObs,
  type Observation,
  type OwnPokemonObs,
  type RewardOptionObs,
  type RunObs,
  type StageObs,
  VISIBLE_BATTLER_TAGS,
} from "./observation";

// #region sizes

export const MAX_PARTY = 6;
export const MAX_MOVES = 4;
/** Field slots per side. */
export const MAX_FIELD = 2;
/** Reward options: 3, more with Golden Poké Balls. */
export const MAX_REWARDS = 8;
/** The full shop row (getPlayerShopModifierTypeOptionsForWave). */
export const MAX_SHOP = 14;
/** Memory Mushroom: moves to relearn, per Pokémon. */
export const MAX_RELEARN_MOVES = 16;
export const MAX_ME_OPTIONS = 8;
export const MAX_ME_SUB_OPTIONS = 16;
export const MAX_RUN_MODIFIERS = 32;
export const MAX_ENEMY_MODIFIERS = 16;
export const MAX_HELD_ITEMS = 12;
export const MAX_ARENA_TAGS = 8;

/** Balls the command menu can throw, in PokeballType order. */
export const BALLS = [
  PokeballType.POKEBALL,
  PokeballType.GREAT_BALL,
  PokeballType.ULTRA_BALL,
  PokeballType.ROGUE_BALL,
  PokeballType.MASTER_BALL,
] as const;
/** Every biome, in BiomeId order (the IDs have gaps). */
export const BIOMES: readonly BiomeId[] = Object.values(BiomeId);
/** Every stage kind, for the stage one-hot. */
export const STAGE_KINDS = [
  "command",
  "target",
  "switch",
  "checkSwitch",
  "reward",
  "itemTarget",
  "learnMove",
  "evolution",
  "revive",
  "biome",
  "mysteryEncounter",
  "mePokemon",
  "meSubOption",
  "catch",
] as const satisfies readonly StageObs["kind"][];

// #endregion
// #region actions

/** Slots per block of the action space, in order. */
export const ACTION_BLOCKS = {
  /** Move slot, then the same four with `tera`. */
  move: MAX_MOVES * 2,
  /** BattlerIndex 0-3. */
  target: 4,
  /** Party slot. Answers `command`, `switch` and `checkSwitch`; the stage one-hot tells them apart. */
  switch: MAX_PARTY,
  /** By position in BALLS. */
  ball: BALLS.length,
  run: 1,
  stay: 1,
  reward: MAX_REWARDS,
  buy: MAX_SHOP,
  reroll: 1,
  skipReward: 1,
  /** itemTarget with neither `move` nor `fuseWith`: party slot. */
  itemTarget: MAX_PARTY,
  /** itemTarget with `move` (PP items' move slot, Memory Mushroom's relearn index): party slot × move. */
  itemTargetMove: MAX_PARTY * MAX_RELEARN_MOVES,
  /** itemTarget with `fuseWith` (DNA Splicers): party slot × the other party slot. */
  itemTargetFuse: MAX_PARTY * MAX_PARTY,
  /** Move slot to forget. */
  learnMove: MAX_MOVES,
  skipMove: 1,
  /** By position in BIOMES. */
  biome: BIOMES.length,
  evolve: 1,
  cancelEvolution: 1,
  release: MAX_PARTY,
  keepParty: 1,
  revive: MAX_PARTY,
  meOption: MAX_ME_OPTIONS,
  mePokemon: MAX_PARTY,
  meSubOption: MAX_ME_SUB_OPTIONS,
} as const;

export type ActionBlock = keyof typeof ACTION_BLOCKS;

/** First index of each block. */
export const ACTION_OFFSETS = (() => {
  let offset = 0;
  const offsets = {} as Record<ActionBlock, number>;
  for (const [block, size] of Object.entries(ACTION_BLOCKS) as [ActionBlock, number][]) {
    offsets[block] = offset;
    offset += size;
  }
  return offsets;
})();

export const N_ACTIONS = Object.values(ACTION_BLOCKS).reduce((a, b) => a + b, 0);

/** The index of `action` in the action space, or `null` if it is past a cap and has no slot. */
export function actionIndex(action: Action): number | null {
  let block: ActionBlock;
  let i = 0;
  switch (action.kind) {
    case "move":
      block = "move";
      i = cell(action.tera ? 1 : 0, action.slot, MAX_MOVES);
      break;
    case "switch":
      block = "switch";
      i = action.partySlot;
      break;
    case "ball":
      block = "ball";
      i = BALLS.indexOf(action.ball as (typeof BALLS)[number]);
      break;
    case "run":
      block = "run";
      break;
    case "target":
      block = "target";
      i = action.target;
      break;
    case "stay":
      block = "stay";
      break;
    case "reward":
      block = "reward";
      i = action.index;
      break;
    case "buy":
      block = "buy";
      i = action.index;
      break;
    case "reroll":
      block = "reroll";
      break;
    case "skipReward":
      block = "skipReward";
      break;
    case "itemTarget":
      // `move` and `fuseWith` can be 0, so test for presence, not truthiness.
      if (action.move !== undefined) {
        block = "itemTargetMove";
        i = cell(action.partySlot, action.move, MAX_RELEARN_MOVES);
      } else if (action.fuseWith === undefined) {
        block = "itemTarget";
        i = action.partySlot;
      } else {
        block = "itemTargetFuse";
        i = cell(action.partySlot, action.fuseWith, MAX_PARTY);
      }
      break;
    case "learnMove":
      block = "learnMove";
      i = action.forget;
      break;
    case "biome":
      block = "biome";
      i = BIOMES.indexOf(action.biome);
      break;
    case "cancelEvolution":
      block = "cancelEvolution";
      break;
    case "evolve":
      block = "evolve";
      break;
    case "keepParty":
      block = "keepParty";
      break;
    case "meOption":
      block = "meOption";
      i = action.index;
      break;
    case "mePokemon":
      block = "mePokemon";
      i = action.partySlot;
      break;
    case "meSubOption":
      block = "meSubOption";
      i = action.index;
      break;
    case "release":
      block = "release";
      i = action.partySlot;
      break;
    case "revive":
      block = "revive";
      i = action.partySlot;
      break;
    case "skipMove":
      block = "skipMove";
      break;
  }
  // Past a cap (or a column past its width, from cell()): no slot.
  return i >= 0 && i < ACTION_BLOCKS[block] ? ACTION_OFFSETS[block] + i : null;
}

/** Position of (row, col) in a row-major block `cols` wide, or -1 if `col` doesn't fit. */
function cell(row: number, col: number, cols: number): number {
  return col < cols ? row * cols + col : -1;
}

/** The mask of the legal actions: `mask[i]` is true iff some legal action has index `i`. */
export function actionMask(legal: readonly Action[]): boolean[] {
  const mask = new Array<boolean>(N_ACTIONS).fill(false);
  for (const action of legal) {
    const index = actionIndex(action);
    if (index !== null) {
      mask[index] = true;
    }
  }
  if (!mask.includes(true)) {
    throw new Error(`No legal action has a slot: ${JSON.stringify(legal)}`);
  }
  return mask;
}

/** The legal action at `index`. Throws if `index` is masked. */
export function decodeAction(index: number, legal: readonly Action[]): Action {
  const action = legal.find(a => actionIndex(a) === index);
  if (action === undefined) {
    throw new Error(`Action index ${index} is not legal; legal: ${JSON.stringify(legal)}`);
  }
  return action;
}

// #endregion
// #region observation

/** Appends values to the observation vector. */
export class Writer {
  readonly values: number[] = [];

  num(x: number): void {
    this.values.push(x);
  }

  flag(b: boolean): void {
    this.values.push(b ? 1 : 0);
  }

  /** An ID slot: `id + 1`, or 0 for none or unknown. */
  id(id: number | null): void {
    this.values.push(id == null ? 0 : id + 1);
  }

  /** `size` values, 1 at `index` (all 0 if `index` is null or out of range). */
  oneHot(index: number | null, size: number): void {
    for (let i = 0; i < size; i++) {
      this.values.push(i === index ? 1 : 0);
    }
  }

  /** `size` values, 1 at each of `indices`. */
  multiHot(indices: Iterable<number>, size: number): void {
    const set = new Set(indices);
    for (let i = 0; i < size; i++) {
      this.values.push(set.has(i) ? 1 : 0);
    }
  }

  /** Run `write`, then pad with zeros to exactly `width` values. Throws if `write` wrote more. */
  fixed(width: number, write: () => void): void {
    const start = this.values.length;
    write();
    const written = this.values.length - start;
    if (written > width) {
      throw new Error(`Wrote ${written} values into a block of ${width}`);
    }
    for (let i = written; i < width; i++) {
      this.values.push(0);
    }
  }

  /** `max` blocks of `width`: `write(item)` for each item that is not null (up to `max`), zeros otherwise. */
  slots<T>(items: readonly (T | null)[], max: number, width: number, write: (item: T) => void): void {
    for (let i = 0; i < max; i++) {
      const item = items[i] ?? null;
      this.fixed(width, () => {
        if (item !== null) {
          write(item);
        }
      });
    }
  }
}

/** Item keys in a fixed order, for item ID slots. `modifierTypes` is filled when the game starts. */
let itemKeys: Map<string, number> | null = null;

function itemIndex(key: string): number {
  itemKeys ??= new Map(
    Object.keys(modifierTypes)
      .sort()
      .map((k, i) => [k, i]),
  );
  const index = itemKeys.get(key);
  if (index === undefined) {
    throw new Error(`Unknown item key ${key}`);
  }
  return index;
}

/** Item ID, its first numeric argument (berry, stat, type, TM move...), stack count, battles left. */
const ITEM_WIDTH = 5;

function encodeItem(w: Writer, item: Pick<ItemObs, "id" | "args"> & Partial<ItemObs>): void {
  w.id(itemIndex(item.id));
  w.id(typeof item.args[0] === "number" ? item.args[0] : null);
  w.num((item.count ?? 0) / 10);
  w.flag(item.battlesLeft != null);
  w.num((item.battlesLeft ?? 0) / 10);
}

const RUN_WIDTH = 3 + BALLS.length + MAX_RUN_MODIFIERS * ITEM_WIDTH;

function encodeRun(w: Writer, run: RunObs): void {
  w.num(run.wave / 200);
  w.id(run.biomeId);
  w.num(Math.log10(1 + run.money) / 6);
  for (const ball of BALLS) {
    w.num((run.pokeballs[ball] ?? 0) / 10);
  }
  w.slots(run.modifiers, MAX_RUN_MODIFIERS, ITEM_WIDTH, m => encodeItem(w, m));
}

/** Weather (10 types) or terrain (5): type, turns left, lasts indefinitely. */
function encodeFieldEffect(w: Writer, effect: FieldEffectObs | null, types: number): void {
  w.oneHot(effect?.type ?? null, types);
  w.num((effect?.turnsLeft ?? 0) / 8);
  w.flag(effect != null && effect.turnsLeft === 0);
}

const ARENA_TAG_TYPES: readonly string[] = Object.values(ArenaTagType);
/** Tag type, side (both, player, enemy), turns left, lasts indefinitely, hazard layers. */
const ARENA_TAG_WIDTH = 1 + 3 + 3;
/** Present, sent out, species once sent out, fainted, statused. */
const TRAY_BALL_WIDTH = 5;
const TRAINER_WIDTH = 2 + 3 + MAX_PARTY * TRAY_BALL_WIDTH;

function encodeBattle(w: Writer, battle: BattleObs): void {
  w.oneHot(battle.battleType, 4);
  w.flag(battle.double);
  w.num(battle.turn / 20);
  encodeFieldEffect(w, battle.weather, 10);
  encodeFieldEffect(w, battle.terrain, 5);
  w.slots(battle.arenaTags, MAX_ARENA_TAGS, ARENA_TAG_WIDTH, tag => {
    w.id(ARENA_TAG_TYPES.indexOf(tag.type));
    w.oneHot(tag.side, 3);
    w.num(tag.turnsLeft / 8);
    w.flag(tag.turnsLeft === 0);
    w.num(tag.layers / 3);
  });
  const trainer = battle.trainer;
  w.flag(trainer !== null);
  w.id(trainer?.trainerType ?? null);
  w.oneHot(trainer?.variant ?? null, 3);
  w.slots(trainer?.party ?? [], MAX_PARTY, TRAY_BALL_WIDTH, ball => {
    w.flag(true);
    w.flag(ball.seenSpeciesId !== null);
    w.id(ball.seenSpeciesId);
    w.flag(ball.fainted);
    w.flag(ball.statused);
  });
  w.slots(battle.enemyModifiers, MAX_ENEMY_MODIFIERS, ITEM_WIDTH, m => encodeItem(w, m));
  // By field slot, so an enemy keeps its slot when its ally faints.
  const enemies = Array.from({ length: MAX_FIELD }, (_, i) => battle.enemies.find(e => e.fieldIndex === i) ?? null);
  w.slots(enemies, MAX_FIELD, ENEMY_WIDTH, e => encodeEnemy(w, e));
}

/** Visible battler tags, as a multi-hot in VISIBLE_BATTLER_TAGS order. */
const BATTLER_TAGS: readonly string[] = [...VISIBLE_BATTLER_TAGS];

/** Species, form, fused species, fused form. */
const SPECIES_WIDTH = 4;

function encodeSpecies(w: Writer, p: OwnPokemonObs | EnemyPokemonObs): void {
  w.id(p.speciesId);
  w.id(p.formIndex);
  w.id(p.fusionSpeciesId);
  w.id(p.fusionFormIndex);
}

/** Up to three types (Forest's Curse and Trick-or-Treat add a third). */
const TYPES_WIDTH = 3;

function encodeTypes(w: Writer, types: readonly number[]): void {
  for (let i = 0; i < TYPES_WIDTH; i++) {
    w.id(types[i] ?? null);
  }
}

/** Gender: genderless (-1), male, female. */
const GENDER_WIDTH = 3;
/** StatusEffect NONE..FAINT. */
const STATUS_WIDTH = 8;
/** Stat stages, then visible battler tags. */
const FIELD_WIDTH = 7 + BATTLER_TAGS.length;

function encodeField(w: Writer, field: FieldObs): void {
  for (const stage of field.statStages) {
    w.num(stage / 6);
  }
  w.multiHot(
    field.tags.map(t => BATTLER_TAGS.indexOf(t)),
    BATTLER_TAGS.length,
  );
}

/** Move ID, PP left, max PP. */
const OWN_MOVE_WIDTH = 3;

export const OWN_WIDTH =
  SPECIES_WIDTH
  + 2
  + GENDER_WIDTH
  + 1
  + 1
  + 1
  + 2
  + 2
  + TYPES_WIDTH
  + 1
  + 6
  + 6
  + STATUS_WIDTH
  + 3
  + 3
  + MAX_MOVES * OWN_MOVE_WIDTH
  + MAX_HELD_ITEMS * ITEM_WIDTH
  + FIELD_WIDTH;

/** One of the player's Pokémon, in OWN_WIDTH values. */
function encodeOwnPokemon(w: Writer, p: OwnPokemonObs): void {
  encodeSpecies(w, p);
  w.num(p.level / 100);
  // Total EXP alone says little; what is left to the next level is what the summary bar shows.
  w.num(Math.log10(1 + p.expToNext) / 6);
  w.oneHot(p.gender + 1, GENDER_WIDTH);
  w.flag(p.shiny);
  w.id(p.nature);
  w.id(p.abilityId);
  // Not unlocked, not unknown: our own passive is always known.
  w.flag(p.passiveAbilityId !== null);
  w.id(p.passiveAbilityId);
  w.id(p.teraType);
  w.flag(p.terastallized);
  encodeTypes(w, p.types);
  w.num(p.stats[0] > 0 ? p.hp / p.stats[0] : 0);
  for (const stat of p.stats) {
    w.num(stat / 500);
  }
  for (const iv of p.ivs) {
    w.num(iv / 31);
  }
  w.oneHot(p.status, STATUS_WIDTH);
  w.flag(p.pokerus);
  w.num(p.friendship / 255);
  w.num(p.luck / 14);
  w.oneHot(p.fieldIndex + 1, 3);
  w.slots(p.moves, MAX_MOVES, OWN_MOVE_WIDTH, m => {
    w.id(m.moveId);
    w.num(m.maxPp > 0 ? m.pp / m.maxPp : 0);
    w.num(m.maxPp / 64);
  });
  w.slots(p.items, MAX_HELD_ITEMS, ITEM_WIDTH, item => encodeItem(w, item));
  encodeField(w, p.field);
}

/** Known, move ID, PP used. A padded slot (all 0) is a move not seen yet. */
const ENEMY_MOVE_WIDTH = 3;

export const ENEMY_WIDTH =
  SPECIES_WIDTH
  + 1
  + GENDER_WIDTH
  + 1
  + TYPES_WIDTH
  + 2
  + 3
  + STATUS_WIDTH
  + MAX_HELD_ITEMS * ITEM_WIDTH
  + MAX_MOVES * ENEMY_MOVE_WIDTH
  + 2
  + 2
  + FIELD_WIDTH;

/** An enemy on the field, in ENEMY_WIDTH values. */
function encodeEnemy(w: Writer, e: EnemyPokemonObs): void {
  encodeSpecies(w, e);
  w.num(e.level / 100);
  w.oneHot(e.gender + 1, GENDER_WIDTH);
  w.flag(e.shiny);
  encodeTypes(w, e.types);
  w.flag(e.terastallized);
  w.id(e.teraType);
  w.num(e.hp);
  w.num(e.bossSegments / 5);
  w.num(e.bossSegmentIndex / 5);
  w.oneHot(e.status, STATUS_WIDTH);
  w.slots(e.items, MAX_HELD_ITEMS, ITEM_WIDTH, item => encodeItem(w, item));
  w.slots(e.revealedMoves, MAX_MOVES, ENEMY_MOVE_WIDTH, m => {
    w.flag(true);
    w.id(m.moveId);
    w.num(m.ppUsed / 32);
  });
  // Known flag first: an unrevealed ability is (0, 0), AbilityId.NONE revealed would be (1, 1).
  w.flag(e.revealedAbilityId !== null);
  w.id(e.revealedAbilityId);
  w.flag(e.revealedPassiveId !== null);
  w.id(e.revealedPassiveId);
  encodeField(w, e.field);
}

const BATTLE_WIDTH =
  4
  + 2
  + (10 + 2)
  + (5 + 2)
  + MAX_ARENA_TAGS * ARENA_TAG_WIDTH
  + TRAINER_WIDTH
  + MAX_ENEMY_MODIFIERS * ITEM_WIDTH
  + MAX_FIELD * ENEMY_WIDTH;

/** MysteryEncounterTier, whose values are spawn weights rather than positions. */
const ME_TIERS = [
  MysteryEncounterTier.COMMON,
  MysteryEncounterTier.GREAT,
  MysteryEncounterTier.ULTRA,
  MysteryEncounterTier.ROGUE,
  MysteryEncounterTier.MASTER,
];
/** ModifierTier COMMON..LUXURY. */
const MODIFIER_TIERS = 6;
/** Item ID, first numeric argument, tier, cost, tier upgrades. */
const REWARD_WIDTH = 2 + MODIFIER_TIERS + 2;
/** Present, greyed out, highlighted. Labels and tooltips are text: the encounter type and index stand in. */
const ME_OPTION_WIDTH = 3;

const STAGE_WIDTHS = {
  fieldSlot: MAX_FIELD + 1,
  reward: (MAX_REWARDS + MAX_SHOP) * REWARD_WIDTH + 2,
  itemTarget: ITEM_WIDTH,
  partySlotAndId: MAX_PARTY + 1,
  biome: BIOMES.length,
  mysteryEncounter: 1 + ME_TIERS.length + 1 + MAX_ME_OPTIONS * ME_OPTION_WIDTH,
  mePokemon: 1 + MAX_ME_OPTIONS,
  meSubOption: 1 + MAX_ME_OPTIONS + MAX_ME_SUB_OPTIONS,
  catch: OWN_WIDTH,
};

export const STAGE_WIDTH = Math.max(...Object.values(STAGE_WIDTHS));

function encodeReward(w: Writer, option: RewardOptionObs): void {
  w.id(itemIndex(option.id));
  w.id(typeof option.args[0] === "number" ? option.args[0] : null);
  w.oneHot(option.tier, MODIFIER_TIERS);
  w.num(Math.log10(1 + option.cost) / 6);
  w.num(option.upgradeCount / 3);
}

/** The stage-specific part, in STAGE_WIDTH values. Every stage writes from the start of the same block. */
function encodeStage(w: Writer, stage: StageObs): void {
  switch (stage.kind) {
    case "command":
    case "switch":
    case "checkSwitch":
      w.oneHot(stage.fieldIndex, MAX_FIELD);
      return;
    case "target":
      w.oneHot(stage.fieldIndex, MAX_FIELD);
      w.id(stage.moveId);
      return;
    case "reward":
      w.slots(stage.options, MAX_REWARDS, REWARD_WIDTH, o => encodeReward(w, o));
      w.slots(stage.shop, MAX_SHOP, REWARD_WIDTH, o => encodeReward(w, o));
      // -1 when the screen offers no reroll (only the shop is left).
      w.flag(stage.rerollCost >= 0);
      w.num(Math.log10(1 + Math.max(0, stage.rerollCost)) / 6);
      return;
    case "itemTarget":
      encodeItem(w, stage.item);
      return;
    case "learnMove":
      w.oneHot(stage.partySlot, MAX_PARTY);
      w.id(stage.moveId);
      return;
    case "evolution":
      w.oneHot(stage.partySlot, MAX_PARTY);
      w.id(stage.speciesId);
      return;
    case "revive":
      return;
    case "biome":
      // Same positions as the biome block of the action space.
      w.multiHot(
        stage.choices.map(b => BIOMES.indexOf(b as BiomeId)),
        BIOMES.length,
      );
      return;
    case "mysteryEncounter":
      w.id(stage.encounterType);
      w.oneHot(ME_TIERS.indexOf(stage.tier), ME_TIERS.length);
      w.flag(stage.followUp);
      w.slots(stage.options, MAX_ME_OPTIONS, ME_OPTION_WIDTH, o => {
        w.flag(true);
        w.flag(o.disabled);
        w.flag(o.special);
      });
      return;
    case "mePokemon":
      w.id(stage.encounterType);
      w.oneHot(stage.option, MAX_ME_OPTIONS);
      return;
    case "meSubOption":
      w.id(stage.encounterType);
      w.oneHot(stage.option, MAX_ME_OPTIONS);
      w.multiHot(range(Math.min(stage.labels.length, MAX_ME_SUB_OPTIONS)), MAX_ME_SUB_OPTIONS);
      return;
    case "catch":
      encodeOwnPokemon(w, stage.pokemon);
      return;
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export const OBS_DIM = STAGE_KINDS.length + STAGE_WIDTH + RUN_WIDTH + MAX_PARTY * OWN_WIDTH + BATTLE_WIDTH;

/** The observation as OBS_DIM numbers. */
export function encodeObservation(obs: Observation): number[] {
  const w = new Writer();
  w.oneHot(STAGE_KINDS.indexOf(obs.stage.kind), STAGE_KINDS.length);
  w.fixed(STAGE_WIDTH, () => encodeStage(w, obs.stage));
  w.fixed(RUN_WIDTH, () => encodeRun(w, obs.run));
  w.slots(obs.party, MAX_PARTY, OWN_WIDTH, p => encodeOwnPokemon(w, p));
  w.fixed(BATTLE_WIDTH, () => encodeBattle(w, obs.battle));
  return w.values;
}

// #endregion
