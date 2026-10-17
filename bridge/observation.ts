// The fair-information observation (issue #5): the only view of the game a policy gets.
//
// It copies named, player-visible values out of the game state. Nothing is spread or serialized from a
// game object, so a field is hidden unless it is listed here. The output is plain JSON (numbers, strings,
// booleans, null, arrays, plain objects) with no game objects in it. IDs are the game's enum values
// (numbers, except battler/arena tag types, which are string enums upstream) and item IDs, which are
// modifier type keys such as "LEFTOVERS". Species, move, ability and type data are static lookups by ID:
// see bridge/static-data.ts.
//
// Every observation is Observation = { stage, run, party, battle }: the context shown on every screen
// plus the stage-specific part. What is visible where, and so what each part holds:
//
// | Part            | Seen on                                  | Holds                                       |
// |-----------------|------------------------------------------|---------------------------------------------|
// | run             | always (top bar, modifier bar, bag)      | wave, biome, money, Poké Ball counts,        |
// |                 |                                          | player modifiers that are not held items     |
// | party           | party and summary screens                | per Pokémon: species, form, fusion, level,   |
// |                 |                                          | EXP and EXP to next level, gender, shiny,    |
// |                 |                                          | nature, ability, passive (if unlocked), tera |
// |                 |                                          | type, types, HP, stats, IVs, status, Pokérus,|
// |                 |                                          | friendship, luck, moves with PP, held items; |
// |                 |                                          | on the field also stat stages and visible    |
// |                 |                                          | battler tags                                 |
// | battle          | battle screen, arena flyout, enemy       | battle type, double, turn, weather and       |
// |                 | battle info + flyout, enemy modifier     | terrain (+ turns left), arena tags per side  |
// |                 | bar, enemy Poké Ball tray                | (+ turns left, hazard layers), trainer class |
// |                 |                                          | and tray, enemy non-held modifiers, enemies  |
// | battle.enemies  | enemy battle info, flyout, item bar      | per enemy on the field: species, form,       |
// |                 |                                          | fusion, level, gender, shiny, types, tera,   |
// |                 |                                          | HP bar fraction, boss segments, status,      |
// |                 |                                          | stat stages, visible battler tags, held      |
// |                 |                                          | items, moves and abilities revealed so far   |
// | stage           | the screen asking for input              | command/target/switch: field slot (+ move);  |
// |                 |                                          | reward: options, shop, reroll cost;          |
// |                 |                                          | learnMove: party slot, new move;             |
// |                 |                                          | biome: choices; mysteryEncounter: type,      |
// |                 |                                          | tier, options; catch: the caught Pokémon     |
//
// Never included: enemy IVs, nature, exact stats or HP, moves and abilities not yet revealed, trainer
// Pokémon not yet sent out, RNG state or seeds, anything about future waves, reward options before the
// reward screen. Enemy HP is quantized to whole pixels of its HP bar (48 px, 86 px for bosses).
//
// Building an observation has no side effects on the game (no RNG calls, no state changes). Data that only
// a UI handler holds is passed in by the caller in a StageInput, taken from the UI mode's args.

import type { BattleScene } from "#app/battle-scene";
import { getLevelTotalExp } from "#data/exp";
import { BattlerTagType } from "#enums/battler-tag-type";
import type { BiomeId } from "#enums/biome-id";
import type { MoveId } from "#enums/move-id";
import { MysteryEncounterOptionMode } from "#enums/mystery-encounter-option-mode";
import { PERMANENT_STATS } from "#enums/stat";
import type { EnemyPokemon, Pokemon } from "#field/pokemon";
import {
  HealShopCostModifier,
  LapsingPersistentModifier,
  type PersistentModifier,
  PokemonHeldItemModifier,
} from "#modifiers/modifier";
import {
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierType,
  type ModifierTypeOption,
  TmModifierType,
} from "#modifiers/modifier-type";
import { NumberHolder } from "#utils/common";
import type { RevealTracker } from "./reveal-tracker";

// #region Observation types

/** An item or modifier as its icon shows it. */
export interface ItemObs {
  /** Modifier type key, e.g. "LEFTOVERS", "BERRY", "ATTACK_TYPE_BOOSTER". */
  id: string;
  /** What distinguishes items sharing an `id`: berry type, stat, move type, TM move, evolution item, etc. */
  args: (number | string)[];
  /** Stack count. */
  count: number;
  /** Battles left for items that run out (Lures, X items), else `null`. */
  battlesLeft: number | null;
}

/** A move slot as the summary and fight menu show it. */
export interface MoveObs {
  moveId: number;
  pp: number;
  maxPp: number;
}

/** Battle-only state shown for a Pokémon on the field (either side). */
export interface FieldObs {
  /** Stage of [Atk, Def, SpAtk, SpDef, Spd, Acc, Eva], -6..6, as in the battle info stat box. */
  statStages: number[];
  /** Battler tags announced in battle messages; see {@linkcode VISIBLE_BATTLER_TAGS}. */
  tags: string[];
}

/** One of the player's Pokémon: everything its summary screen shows. */
export interface OwnPokemonObs {
  speciesId: number;
  formIndex: number;
  /** Fused species, or `null` if not fused. */
  fusionSpeciesId: number | null;
  fusionFormIndex: number | null;
  level: number;
  exp: number;
  /** EXP needed for the next level, 0 at the level cap. */
  expToNext: number;
  gender: number;
  shiny: boolean;
  nature: number;
  abilityId: number;
  /** Passive ability, or `null` if it is not unlocked. */
  passiveAbilityId: number | null;
  teraType: number;
  terastallized: boolean;
  types: number[];
  hp: number;
  /** [HP, Atk, Def, SpAtk, SpDef, Spd]; stats[0] is max HP. */
  stats: number[];
  ivs: number[];
  /** StatusEffect, 0 for none. */
  status: number;
  pokerus: boolean;
  friendship: number;
  luck: number;
  moves: MoveObs[];
  items: ItemObs[];
  /** Field slot (0 or 1) if on the field, else -1. */
  fieldIndex: number;
  /** Battle-only state; neutral (zero stages, no tags) when not on the field. */
  field: FieldObs;
}

/** An enemy on the field: what its battle info, flyout and the item bar show. */
export interface EnemyPokemonObs {
  fieldIndex: number;
  /** Species and form shown, which is the disguise while Illusion holds. */
  speciesId: number;
  formIndex: number;
  fusionSpeciesId: number | null;
  fusionFormIndex: number | null;
  level: number;
  gender: number;
  shiny: boolean;
  types: number[];
  terastallized: boolean;
  /** Tera type once terastallized, else `null`. */
  teraType: number | null;
  /** HP bar fill in (0, 1], in whole bar pixels (48, or 86 for a boss); 0 only when fainted. */
  hp: number;
  /** Number of HP bar segments (boss shields), 0 if not a boss. */
  bossSegments: number;
  bossSegmentIndex: number;
  status: number;
  field: FieldObs;
  /** Held items, as the enemy item bar shows them. */
  items: ItemObs[];
  /** Moves seen so far this run, in order seen, with PP used as the flyout shows it. */
  revealedMoves: { moveId: number; ppUsed: number }[];
  /** Ability shown by an ability popup or named in a message, else `null`. */
  revealedAbilityId: number | null;
  revealedPassiveId: number | null;
}

/** Weather or terrain, as the arena flyout shows it. */
export interface FieldEffectObs {
  type: number;
  /** Turns left, 0 if it lasts indefinitely. */
  turnsLeft: number;
  maxTurns: number;
}

export interface ArenaTagObs {
  type: string;
  /** ArenaTagSide: 0 both, 1 player, 2 enemy. */
  side: number;
  /** Turns left, 0 if it lasts indefinitely. */
  turnsLeft: number;
  maxTurns: number;
  /** Entry hazard layers, 0 for other tags. */
  layers: number;
}

/** A Poké Ball in the enemy trainer's tray. Species only for Pokémon already sent out. */
export interface TrayBallObs {
  seenSpeciesId: number | null;
  fainted: boolean;
  statused: boolean;
}

export interface TrainerObs {
  trainerType: number;
  variant: number;
  party: TrayBallObs[];
}

export interface BattleObs {
  battleType: number;
  double: boolean;
  turn: number;
  weather: FieldEffectObs | null;
  terrain: FieldEffectObs | null;
  arenaTags: ArenaTagObs[];
  trainer: TrainerObs | null;
  /** Enemy modifiers that are not held items (enemy buffs), as the enemy item bar shows them. */
  enemyModifiers: ItemObs[];
  enemies: EnemyPokemonObs[];
}

export interface RunObs {
  wave: number;
  biomeId: number;
  money: number;
  /** Ball counts indexed by PokeballType. */
  pokeballs: number[];
  /** Player modifiers that are not held items, as the modifier bar shows them. */
  modifiers: ItemObs[];
}

/** A reward or shop option on the reward screen. */
export interface RewardOptionObs extends Omit<ItemObs, "count" | "battlesLeft"> {
  /** ModifierTier. */
  tier: number;
  /** Price in money; 0 for free rewards. */
  cost: number;
  /** Number of tier upgrades the option rolled (shown as the option's animation). */
  upgradeCount: number;
}

export interface MysteryEncounterOptionObs {
  /** Greyed out and not selectable: requirements not met. */
  disabled: boolean;
  /** Shown highlighted: a special option whose requirements are met. */
  special: boolean;
}

export type StageObs =
  | { kind: "command"; fieldIndex: number }
  | { kind: "target"; fieldIndex: number; moveId: number }
  | { kind: "switch"; fieldIndex: number }
  | { kind: "reward"; options: RewardOptionObs[]; shop: RewardOptionObs[]; rerollCost: number }
  | { kind: "learnMove"; partySlot: number; moveId: number }
  | { kind: "biome"; choices: number[] }
  | { kind: "mysteryEncounter"; encounterType: number; tier: number; options: MysteryEncounterOptionObs[] }
  | { kind: "catch"; pokemon: OwnPokemonObs };

export interface Observation {
  stage: StageObs;
  run: RunObs;
  party: OwnPokemonObs[];
  battle: BattleObs;
}

// #endregion

/**
 * What the caller knows about the decision being observed. For the battle stages this is the driver's
 * decision; the others carry data only the UI holds.
 */
export type StageInput =
  | { kind: "command"; fieldIndex: number }
  | { kind: "target"; fieldIndex: number; moveId: MoveId }
  | { kind: "switch"; fieldIndex: number }
  /** MODIFIER_SELECT mode args: `options` is args[1], `rerollCost` args[3]. */
  | { kind: "reward"; options: readonly ModifierTypeOption[]; rerollCost: number }
  /** LearnMovePhase's party slot and move (the SUMMARY mode in LEARN_MOVE gets the move as args[2]). */
  | { kind: "learnMove"; partySlot: number; moveId: MoveId }
  /** SelectBiomePhase's choices, in the order of the OPTION_SELECT labels. */
  | { kind: "biome"; choices: readonly BiomeId[] }
  /**
   * MysteryEncounterUiHandler.optionsMeetsReqs, which the UI computes when it shows the options. Not
   * recomputed here: MysteryEncounterOption.meetsRequirements() draws from the RNG and picks Pokémon.
   */
  | { kind: "mysteryEncounter"; optionsMeetsReqs: readonly boolean[] }
  /** AttemptCapturePhase's Pokémon, when the party is full and the game asks whether to release one. */
  | { kind: "catch"; pokemon: Pokemon };

/** Battler tags that battle messages or sprites announce. Others are internal or would reveal an ability. */
export const VISIBLE_BATTLER_TAGS: ReadonlySet<string> = new Set([
  BattlerTagType.RECHARGING,
  BattlerTagType.CONFUSED,
  BattlerTagType.INFATUATED,
  BattlerTagType.SEEDED,
  BattlerTagType.NIGHTMARE,
  BattlerTagType.CHARGING,
  BattlerTagType.ENCORE,
  BattlerTagType.HELPING_HAND,
  BattlerTagType.INGRAIN,
  BattlerTagType.OCTOLOCK,
  BattlerTagType.AQUA_RING,
  BattlerTagType.DROWSY,
  BattlerTagType.TRAPPED,
  BattlerTagType.BIND,
  BattlerTagType.WRAP,
  BattlerTagType.FIRE_SPIN,
  BattlerTagType.WHIRLPOOL,
  BattlerTagType.CLAMP,
  BattlerTagType.SAND_TOMB,
  BattlerTagType.MAGMA_STORM,
  BattlerTagType.SNAP_TRAP,
  BattlerTagType.THUNDER_CAGE,
  BattlerTagType.INFESTATION,
  BattlerTagType.PROTECTED,
  BattlerTagType.SPIKY_SHIELD,
  BattlerTagType.KINGS_SHIELD,
  BattlerTagType.OBSTRUCT,
  BattlerTagType.SILK_TRAP,
  BattlerTagType.BANEFUL_BUNKER,
  BattlerTagType.BURNING_BULWARK,
  BattlerTagType.ENDURING,
  BattlerTagType.PERISH_SONG,
  BattlerTagType.FLYING,
  BattlerTagType.UNDERGROUND,
  BattlerTagType.UNDERWATER,
  BattlerTagType.HIDDEN,
  BattlerTagType.CRIT_BOOST,
  BattlerTagType.IGNORE_ACCURACY,
  BattlerTagType.SALT_CURED,
  BattlerTagType.CURSED,
  BattlerTagType.CHARGED,
  BattlerTagType.FLOATING,
  BattlerTagType.MINIMIZED,
  BattlerTagType.DESTINY_BOND,
  BattlerTagType.CENTER_OF_ATTENTION,
  BattlerTagType.STOCKPILING,
  BattlerTagType.DISABLED,
  BattlerTagType.SUBSTITUTE,
  BattlerTagType.IGNORE_GHOST,
  BattlerTagType.IGNORE_DARK,
  BattlerTagType.BEAK_BLAST_CHARGING,
  BattlerTagType.SHELL_TRAP,
  BattlerTagType.DRAGON_CHEER,
  BattlerTagType.NO_RETREAT,
  BattlerTagType.THROAT_CHOPPED,
  BattlerTagType.TAR_SHOT,
  BattlerTagType.POWER_TRICK,
  BattlerTagType.HEAL_BLOCK,
  BattlerTagType.TORMENT,
  BattlerTagType.TAUNT,
  BattlerTagType.IMPRISON,
  BattlerTagType.SYRUP_BOMB,
  BattlerTagType.ELECTRIFIED,
  BattlerTagType.TELEKINESIS,
  BattlerTagType.GRUDGE,
  BattlerTagType.POWDER,
  BattlerTagType.MAGIC_COAT,
]);

/** Width in pixels of the enemy HP bar (assets/images/ui/overlay_hp.png, overlay_hp_boss.png). */
const HP_BAR_WIDTH = 48;
const BOSS_HP_BAR_WIDTH = 86;

/** Build the observation for the decision described by `input`. */
export function buildObservation(scene: BattleScene, tracker: RevealTracker, input: StageInput): Observation {
  return {
    stage: buildStage(scene, input),
    run: buildRun(scene),
    party: scene.getPlayerParty().map(p => ownPokemon(scene, p)),
    battle: buildBattle(scene, tracker),
  };
}

function buildStage(scene: BattleScene, input: StageInput): StageObs {
  switch (input.kind) {
    case "command":
    case "switch":
      return { kind: input.kind, fieldIndex: input.fieldIndex };
    case "target":
      return { kind: "target", fieldIndex: input.fieldIndex, moveId: input.moveId };
    case "reward":
      return {
        kind: "reward",
        options: input.options.map(rewardOption),
        shop: shopOptions(scene).map(rewardOption),
        rerollCost: input.rerollCost,
      };
    case "learnMove":
      return { kind: "learnMove", partySlot: input.partySlot, moveId: input.moveId };
    case "biome":
      return { kind: "biome", choices: [...input.choices] };
    case "mysteryEncounter": {
      const encounter = scene.currentBattle.mysteryEncounter!;
      return {
        kind: "mysteryEncounter",
        encounterType: encounter.encounterType,
        tier: encounter.encounterTier,
        // Same rules as MysteryEncounterUiHandler.displayEncounterOptions().
        options: encounter.options.map((option, i) => {
          const meets = input.optionsMeetsReqs[i];
          const mode = option.optionMode;
          return {
            disabled:
              !meets
              && (mode === MysteryEncounterOptionMode.DISABLED_OR_DEFAULT
                || mode === MysteryEncounterOptionMode.DISABLED_OR_SPECIAL),
            special:
              option.hasRequirements()
              && meets
              && (mode === MysteryEncounterOptionMode.DEFAULT_OR_SPECIAL
                || mode === MysteryEncounterOptionMode.DISABLED_OR_SPECIAL),
          };
        }),
      };
    }
    case "catch":
      // Once caught, its summary screen can be opened from the "party full" prompt.
      return { kind: "catch", pokemon: ownPokemon(scene, input.pokemon) };
  }
}

function buildRun(scene: BattleScene): RunObs {
  const counts = scene.pokeballCounts;
  const balls = Object.keys(counts).map(Number);
  const pokeballs = Array.from({ length: Math.max(...balls) + 1 }, (_, i) => counts[i] ?? 0);
  return {
    wave: scene.currentBattle.waveIndex,
    biomeId: scene.arena.biomeId,
    money: scene.money,
    pokeballs,
    modifiers: barModifiers(scene, true),
  };
}

function buildBattle(scene: BattleScene, tracker: RevealTracker): BattleObs {
  const battle = scene.currentBattle;
  const { weather, terrain } = scene.arena;
  const trainer = battle.trainer;
  return {
    battleType: battle.battleType,
    double: battle.double,
    turn: battle.turn,
    weather: weather
      ? { type: weather.weatherType, turnsLeft: weather.turnsLeft, maxTurns: weather.maxDuration }
      : null,
    terrain: terrain
      ? { type: terrain.terrainType, turnsLeft: terrain.turnsLeft, maxTurns: terrain.maxDuration }
      : null,
    arenaTags: scene.arena.tags.map(tag => ({
      type: tag.tagType,
      side: tag.side,
      turnsLeft: tag.turnCount,
      maxTurns: tag.maxDuration,
      layers: "layers" in tag ? (tag.layers as number) : 0,
    })),
    trainer: trainer
      ? {
          trainerType: trainer.config.trainerType,
          variant: trainer.variant,
          // The tray shows each ball as fainted, statused or healthy; species are known once sent out.
          party: battle.enemyParty.map(p => ({
            seenSpeciesId: battle.seenEnemyPartyMemberIds.has(p.id) ? p.species.speciesId : null,
            fainted: p.hp <= 0,
            statused: p.status != null,
          })),
        }
      : null,
    enemyModifiers: barModifiers(scene, false),
    enemies: scene
      .getEnemyField()
      .filter(p => p.isOnField())
      .map(p => enemyPokemon(p, tracker)),
  };
}

function ownPokemon(scene: BattleScene, p: Pokemon): OwnPokemonObs {
  const maxLevel = scene.getMaxExpLevel();
  const onField = p.isOnField();
  return {
    speciesId: p.species.speciesId,
    formIndex: p.formIndex,
    fusionSpeciesId: p.fusionSpecies?.speciesId ?? null,
    fusionFormIndex: p.fusionSpecies ? p.fusionFormIndex : null,
    level: p.level,
    exp: p.exp,
    expToNext: p.level < maxLevel ? getLevelTotalExp(p.level + 1, p.species.growthRate) - p.exp : 0,
    gender: p.gender,
    shiny: p.isShiny(),
    nature: p.getNature(),
    abilityId: p.getAbility(true).id,
    passiveAbilityId: p.hasPassive() ? p.getPassiveAbility().id : null,
    teraType: p.getTeraType(),
    terastallized: p.isTerastallized,
    types: [...p.getTypes()],
    hp: p.hp,
    stats: PERMANENT_STATS.map(s => p.getStat(s)),
    ivs: [...p.ivs],
    status: p.status?.effect ?? 0,
    pokerus: p.pokerus,
    friendship: p.friendship,
    luck: p.getLuck(),
    moves: p.getMoveset().map(m => ({ moveId: m.moveId, pp: m.getMovePp() - m.ppUsed, maxPp: m.getMovePp() })),
    items: p.getHeldItems().map(item),
    fieldIndex: onField ? p.getFieldIndex() : -1,
    field: onField ? fieldState(p) : { statStages: [0, 0, 0, 0, 0, 0, 0], tags: [] },
  };
}

function enemyPokemon(p: EnemyPokemon, tracker: RevealTracker): EnemyPokemonObs {
  // The battle info shows the Illusion disguise (getSpeciesForm/getTypes/isShiny with useIllusion).
  const form = p.getSpeciesForm(false, true);
  const fusion = p.isFusion(true) ? p.getFusionSpeciesForm(false, true) : null;
  const boss = p.isBoss();
  const width = boss ? BOSS_HP_BAR_WIDTH : HP_BAR_WIDTH;
  return {
    fieldIndex: p.getFieldIndex(),
    speciesId: form.speciesId,
    formIndex: form.formIndex,
    fusionSpeciesId: fusion?.speciesId ?? null,
    fusionFormIndex: fusion?.formIndex ?? null,
    level: p.level,
    gender: p.getGender(false, true),
    shiny: p.isShiny(true),
    types: [...p.getTypes({ useIllusion: true })],
    terastallized: p.isTerastallized,
    teraType: p.isTerastallized ? p.getTeraType() : null,
    hp: p.hp > 0 ? Math.ceil(p.getHpRatio(true) * width) / width : 0,
    bossSegments: boss ? p.bossSegments : 0,
    bossSegmentIndex: boss ? p.bossSegmentIndex : 0,
    status: p.status?.effect ?? 0,
    field: fieldState(p),
    items: p.getHeldItems().map(item),
    revealedMoves: tracker.moves(p).map(m => ({ moveId: m.moveId, ppUsed: m.ppUsed })),
    revealedAbilityId: tracker.ability(p),
    revealedPassiveId: tracker.passive(p),
  };
}

function fieldState(p: Pokemon): FieldObs {
  return {
    statStages: [...p.getStatStages()],
    tags: p.summonData.tags.map(t => t.tagType).filter(t => VISIBLE_BATTLER_TAGS.has(t)),
  };
}

/** Modifiers that are not held items, as the player's or the enemy's modifier bar shows them. */
function barModifiers(scene: BattleScene, player: boolean): ItemObs[] {
  return scene
    .findModifiers(m => !(m instanceof PokemonHeldItemModifier), player)
    .filter(m => m.isIconVisible())
    .map(item);
}

function item(m: PersistentModifier): ItemObs {
  return {
    id: typeId(m.type),
    args: typeArgs(m.type),
    count: m.getStackCount(),
    battlesLeft: m instanceof LapsingPersistentModifier ? m.getBattleCount() : null,
  };
}

function rewardOption(o: ModifierTypeOption): RewardOptionObs {
  return {
    id: typeId(o.type),
    args: typeArgs(o.type),
    tier: o.type.tier ?? 0,
    cost: o.cost,
    upgradeCount: o.upgradeCount,
  };
}

/** The shop row of the reward screen, computed the way ModifierSelectUiHandler.show() does. */
function shopOptions(scene: BattleScene): ModifierTypeOption[] {
  if (!scene.gameMode.getShopStatus()) {
    return [];
  }
  const baseCost = new NumberHolder(scene.getWaveMoneyAmount(1));
  scene.applyModifier(HealShopCostModifier, true, baseCost);
  return getPlayerShopModifierTypeOptionsForWave(scene.currentBattle.waveIndex, baseCost.value);
}

/**
 * The modifier type key. Shop items are built without one, but their locale key ends in it
 * ("modifierType:ModifierType.POTION").
 */
function typeId(type: ModifierType): string {
  return type.id ?? type.localeKey.split(".").at(-1)!;
}

/** The arguments that tell apart types sharing a key, as the save data stores them (`typePregenArgs`). */
function typeArgs(type: ModifierType): (number | string)[] {
  if ("getPregenArgs" in type && typeof type.getPregenArgs === "function") {
    return [...(type.getPregenArgs() as (number | string)[])];
  }
  if (type instanceof TmModifierType) {
    return [type.moveId];
  }
  return [];
}
