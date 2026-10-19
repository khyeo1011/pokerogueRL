// Policies (issue #10): a policy chooses one of a decision's legal actions from its observation alone.
// It gets the fair-information observation (bridge/observation.ts) and public game data
// (bridge/static-data.ts), never the scene, Pokémon objects or the game's damage calculation, so it
// knows only what a player could. bridge/test/policy-imports.test.ts checks the imports of this file.
//
// defaultPolicy is the scripted policy from issue #7, a simple answer to every decision so that runs
// complete. Battles: the usable move with the highest base power × STAB × type effectiveness against
// the visible enemy types; never switches voluntarily, throws balls or runs. Rewards: the first free
// reward that can be taken (so the item-target and learn-move screens get used), first legal target.
// New moves replace the weakest known move. First biome, evolutions go ahead, caught Pokémon are not
// kept over the party. Mystery encounters (issue #8): a preferred option per encounter type
// (ENCOUNTER_PREFERENCES), else the first legal one; the first legal Pokémon and follow-up entry.
//
// greedyPolicy is the baseline from issue #14. Battles: the move with the most expected damage by the
// visible-data estimate (bridge/damage.ts), capped at the HP left; a switch to a healthy bench Pokémon
// whose best move does at least twice as much. Rewards: shop healing while a Pokémon is below half HP,
// then a revive if one has fainted, healing if one is hurt, levels and EXP, anything else, and balls and
// lures last; never move-teaching items. Healing goes to the Pokémon with the least HP, revives to the
// highest level. New moves are learned only over a weaker one. Everything else as defaultPolicy.
//
// randomPolicy (issue #53) picks uniformly among the legal actions, to hunt game bugs; replayPolicy plays
// back recorded actions.

import { BattlerIndex } from "#enums/battler-index";
import { MoveCategory } from "#enums/move-category";
import { MoveTarget } from "#enums/move-target";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { data, effectiveness, estimateDamage } from "./damage";
import type { Action, ActionOf } from "./decisions";
import type { EnemyPokemonObs, Observation, OwnPokemonObs } from "./observation";

/**
 * Chooses an action for a decision from its observation (`Driver.observe()`) and legal actions
 * (`decision.legal`). Must return one of `legal`.
 */
export type Policy = (obs: Observation, legal: readonly Action[]) => Action;

/**
 * Base power × STAB × type effectiveness of `moveId` used by `user` on a target of `targetTypes`
 * (no effectiveness if omitted). 0 for status moves and moves without a fixed power.
 */
function moveScore(user: OwnPokemonObs, moveId: number, targetTypes?: readonly number[]): number {
  // The moves table is indexed by move ID.
  const move = data().moves[moveId];
  if (move.category === MoveCategory.STATUS || move.power <= 0) {
    return 0;
  }
  const stab = user.types.includes(move.type) ? 1.5 : 1;
  return move.power * stab * (targetTypes ? effectiveness(move.type, targetTypes) : 1);
}

/** The action with the highest score (the first on ties). */
function best<A extends Action>(actions: readonly A[], score: (a: A) => number): A {
  return actions.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** The player's Pokémon in field slot `fieldIndex`. */
function onField(obs: Observation, fieldIndex: number): OwnPokemonObs {
  return obs.party.find(p => p.fieldIndex === fieldIndex)!;
}

/** The scripted default policy. */
export const defaultPolicy: Policy = (obs, legal) => {
  const stage = obs.stage;
  switch (stage.kind) {
    case "command": {
      const pokemon = onField(obs, stage.fieldIndex);
      const enemies = obs.battle.enemies.filter(e => e.hp > 0);
      const moves = legal.filter((a): a is ActionOf<"move"> => a.kind === "move" && !a.tera);
      return best(moves, a => {
        const moveId = pokemon.moves[a.slot]?.moveId;
        return moveId === undefined ? 0 : Math.max(0, ...enemies.map(e => moveScore(pokemon, moveId, e.types)));
      });
    }
    case "target": {
      const user = onField(obs, stage.fieldIndex);
      // Enemies before allies, then the best effectiveness.
      return best(legal, a => {
        if (a.kind !== "target" || a.target < BattlerIndex.ENEMY) {
          return 0;
        }
        const enemy = obs.battle.enemies.find(e => e.fieldIndex === a.target - BattlerIndex.ENEMY);
        return 1 + (enemy ? moveScore(user, stage.moveId, enemy.types) : 0);
      });
    }
    case "checkSwitch":
      return { kind: "stay" };
    case "reward":
      return legal.find(a => a.kind === "reward") ?? { kind: "skipReward" };
    case "learnMove": {
      const pokemon = obs.party[stage.partySlot];
      // Lowest base power × STAB, regardless of the enemy.
      return best(legal, a =>
        a.kind === "learnMove" ? -moveScore(pokemon, pokemon.moves[a.forget].moveId) : Number.NEGATIVE_INFINITY,
      );
    }
    case "evolution":
      return { kind: "evolve" };
    case "catch":
      return { kind: "keepParty" };
    case "mysteryEncounter": {
      if (!stage.followUp) {
        const preferred = ENCOUNTER_PREFERENCES[stage.encounterType as MysteryEncounterType]
          .map(index => legal.find(a => a.kind === "meOption" && a.index === index))
          .find(a => a !== undefined);
        if (preferred) {
          return preferred;
        }
      }
      return legal[0];
    }
    case "switch":
    case "itemTarget":
    case "biome":
    case "revive":
    case "mePokemon":
    case "meSubOption":
      return legal[0];
  }
};

/** Move targets that hit every enemy (and some the ally too, which the greedy policy does not count). */
const SPREAD_TARGETS: ReadonlySet<number> = new Set([
  MoveTarget.ALL_OTHERS,
  MoveTarget.ALL_NEAR_OTHERS,
  MoveTarget.ALL_NEAR_ENEMIES,
  MoveTarget.ALL_ENEMIES,
]);

/**
 * Expected damage of `moveId` by `user` on `enemy` that counts, as a fraction of its HP bar: the estimate
 * times accuracy, capped at the HP left, or at a boss's current shield, which stops a hit.
 */
function hitValue(obs: Observation, user: OwnPokemonObs, moveId: number, enemy: EnemyPokemonObs): number {
  const move = data().moves[moveId];
  const accuracy = move.accuracy < 0 ? 1 : move.accuracy / 100;
  const shield = enemy.bossSegments > 0 ? enemy.bossSegmentIndex / enemy.bossSegments : 0;
  return Math.min(estimateDamage(obs, user, moveId, enemy), enemy.hp - shield) * accuracy;
}

/** Damage value of `moveId` by `user`: on its best target, or summed over the enemies for a spread move. */
function moveValue(obs: Observation, user: OwnPokemonObs, moveId: number): number {
  const enemies = obs.battle.enemies.filter(e => e.hp > 0);
  const values = enemies.map(e => hitValue(obs, user, moveId, e));
  if (SPREAD_TARGETS.has(data().moves[moveId].target)) {
    // Moves hitting more than one target deal 75%.
    return values.reduce((a, b) => a + b, 0) * (enemies.length > 1 ? 0.75 : 1);
  }
  return Math.max(0, ...values);
}

/** Damage value of a Pokémon's best move with PP left. */
function bestMoveValue(obs: Observation, pokemon: OwnPokemonObs): number {
  return Math.max(0, ...pokemon.moves.filter(m => m.pp > 0).map(m => moveValue(obs, pokemon, m.moveId)));
}

/** Healing items, and items that revive a fainted Pokémon. */
const HEALS: ReadonlySet<string> = new Set(["POTION", "SUPER_POTION", "HYPER_POTION", "MAX_POTION", "FULL_RESTORE"]);
const REVIVES: ReadonlySet<string> = new Set(["REVIVE", "MAX_REVIVE", "SACRED_ASH"]);
/** Items that give levels or EXP. */
const EXP_ITEMS: ReadonlySet<string> = new Set([
  "RARE_CANDY",
  "RARER_CANDY",
  "EXP_SHARE",
  "EXP_CHARM",
  "SUPER_EXP_CHARM",
  "GOLDEN_EXP_CHARM",
  "EXP_BALANCE",
]);
/** Items the greedy policy has no use for: it never throws balls, and lures bring double battles. */
const USELESS: ReadonlySet<string> = new Set([
  "POKEBALL",
  "GREAT_BALL",
  "ULTRA_BALL",
  "ROGUE_BALL",
  "MASTER_BALL",
  "LURE",
  "SUPER_LURE",
  "MAX_LURE",
]);

/**
 * Items that teach a move. The greedy policy skips moves weaker than its weakest, and a skipped move
 * gives the item back with the reward screen unchanged, so it would pick the same item forever.
 */
const MOVE_ITEMS: ReadonlySet<string> = new Set(["TM_COMMON", "TM_GREAT", "TM_ULTRA", "MEMORY_MUSHROOM"]);

/** Whether a Pokémon is below half HP and not fainted. */
const hurt = (p: OwnPokemonObs) => p.hp > 0 && p.hp < p.stats[0] / 2;

/**
 * How much the greedy policy wants a reward: a revive when a Pokémon has fainted, healing when one is
 * below half HP, then levels and EXP, then anything else but balls and lures.
 */
function rewardValue(obs: Observation, id: string): number {
  if (REVIVES.has(id)) {
    return obs.party.some(p => p.hp === 0) ? 4 : 1;
  }
  if (HEALS.has(id)) {
    return obs.party.some(hurt) ? 3 : 1;
  }
  return EXP_ITEMS.has(id) ? 2 : USELESS.has(id) ? 0 : 1;
}

/** The greedy baseline policy. */
export const greedyPolicy: Policy = (obs, legal) => {
  const stage = obs.stage;
  switch (stage.kind) {
    case "command": {
      const pokemon = onField(obs, stage.fieldIndex);
      const value = (a: ActionOf<"move">) => {
        const moveId = pokemon.moves[a.slot]?.moveId;
        return moveId === undefined ? 0 : moveValue(obs, pokemon, moveId);
      };
      const move = best(
        legal.filter((a): a is ActionOf<"move"> => a.kind === "move" && !a.tera),
        value,
      );
      // Switch to the healthy bench Pokémon whose best move does the most, if it does twice as much (so
      // also when no move does damage).
      const switches = legal.filter(
        (a): a is ActionOf<"switch"> => a.kind === "switch" && !hurt(obs.party[a.partySlot]),
      );
      const switchValue = (a: ActionOf<"switch">) => bestMoveValue(obs, obs.party[a.partySlot]);
      const swap = switches.length > 0 ? best(switches, switchValue) : undefined;
      return swap && switchValue(swap) > 0 && switchValue(swap) >= 2 * value(move) ? swap : move;
    }
    case "target": {
      const user = onField(obs, stage.fieldIndex);
      // The enemy it damages most; allies only when there is no enemy to target.
      return best(legal, a => {
        if (a.kind !== "target" || a.target < BattlerIndex.ENEMY) {
          return -1;
        }
        const enemy = obs.battle.enemies.find(e => e.fieldIndex === a.target - BattlerIndex.ENEMY);
        return enemy ? hitValue(obs, user, stage.moveId, enemy) : 0;
      });
    }
    case "switch":
      // Send in the Pokémon whose best move does the most damage.
      return best(legal, a => (a.kind === "switch" ? bestMoveValue(obs, obs.party[a.partySlot]) : -1));
    case "reward": {
      // Buy healing while a Pokémon is below half HP (the shop stays open), then take the best reward.
      const heal = legal.find(a => a.kind === "buy" && HEALS.has(stage.shop[a.index].id));
      if (heal && obs.party.some(hurt)) {
        return heal;
      }
      const rewards = legal.filter(
        (a): a is ActionOf<"reward"> => a.kind === "reward" && !MOVE_ITEMS.has(stage.options[a.index].id),
      );
      return rewards.length > 0 ? best(rewards, a => rewardValue(obs, stage.options[a.index].id)) : { kind: "skipReward" };
    }
    case "itemTarget": {
      // Healing to the Pokémon with the least HP left, a revive to the highest level; others as defaultPolicy.
      const id = stage.item.id;
      if (!HEALS.has(id) && !REVIVES.has(id)) {
        return defaultPolicy(obs, legal);
      }
      return best(legal, a => {
        const p = a.kind === "itemTarget" ? obs.party[a.partySlot] : undefined;
        return p === undefined ? Number.NEGATIVE_INFINITY : HEALS.has(id) ? -p.hp / p.stats[0] : p.level;
      });
    }
    case "learnMove": {
      // Replace the weakest move only with a stronger one.
      const pokemon = obs.party[stage.partySlot];
      const weakest = Math.min(...pokemon.moves.map(m => moveScore(pokemon, m.moveId)));
      return moveScore(pokemon, stage.moveId) > weakest ? defaultPolicy(obs, legal) : { kind: "skipMove" };
    }
    default:
      return defaultPolicy(obs, legal);
  }
};

/**
 * A policy that picks uniformly among the legal actions, to find game bugs in states the default policy
 * never reaches (issue #53): switches, balls, running, the shop, rerolls, releases. Its RNG is its own,
 * seeded from "policy:" + `seed` (FNV-1a, then mulberry32), so it draws nothing from the game's RNG or
 * Math.random, and a run replays from its seed.
 */
export function randomPolicy(seed: string): Policy {
  let state = 0x811c9dc5;
  for (const c of `policy:${seed}`) {
    state = Math.imul(state ^ c.codePointAt(0)!, 0x01000193);
  }
  return (_obs, legal) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return legal[Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * legal.length)];
  };
}

/**
 * Plays back `actions` in order, e.g. the actions recorded for a truncated run, to replay a run whatever
 * policy played it. Throws when they run out; the driver throws if one is not legal (the replay diverged).
 */
export function replayPolicy(actions: readonly Action[]): Policy {
  let i = 0;
  return () => {
    if (i >= actions.length) {
      throw new Error(`Replay ran out of actions after ${i}`);
    }
    return actions[i++];
  };
}

/**
 * Option indices to try in order, per encounter type. Mostly the safe choice: leave or decline where the
 * outcome is a gamble, take free rewards where they need no battle. Every type is listed.
 */
export const ENCOUNTER_PREFERENCES: Record<MysteryEncounterType, number[]> = {
  [MysteryEncounterType.MYSTERIOUS_CHALLENGERS]: [0], // the standard battle
  [MysteryEncounterType.MYSTERIOUS_CHEST]: [1], // leave: opening can KO the strongest Pokémon
  [MysteryEncounterType.DARK_DEAL]: [1], // refuse
  [MysteryEncounterType.FIGHT_OR_FLIGHT]: [1, 2], // steal the item, else leave
  [MysteryEncounterType.SLUMBERING_SNORLAX]: [2, 1], // steal the item, else wait (heals the party)
  [MysteryEncounterType.TRAINING_SESSION]: [3], // leave
  [MysteryEncounterType.DEPARTMENT_STORE_SALE]: [1], // vitamin shop
  [MysteryEncounterType.SHADY_VITAMIN_DEALER]: [1, 2], // the pricey deal (no side effects), else leave
  [MysteryEncounterType.FIELD_TRIP]: [0],
  [MysteryEncounterType.SAFARI_ZONE]: [1], // leave
  [MysteryEncounterType.LOST_AT_SEA]: [0, 1, 2], // a Pokémon helps, else wander
  [MysteryEncounterType.FIERY_FALLOUT]: [2, 0], // fire types help, else battle
  [MysteryEncounterType.THE_STRONG_STUFF]: [0],
  [MysteryEncounterType.THE_POKEMON_SALESMAN]: [1], // refuse
  [MysteryEncounterType.AN_OFFER_YOU_CANT_REFUSE]: [1, 2], // extort, else leave
  [MysteryEncounterType.DELIBIRDY]: [0, 1, 2],
  [MysteryEncounterType.ABSOLUTE_AVARICE]: [1], // reason with it
  [MysteryEncounterType.A_TRAINERS_TEST]: [1], // refuse: full heal and an egg
  [MysteryEncounterType.TRASH_TO_TREASURE]: [1], // dig for valuables
  [MysteryEncounterType.BERRIES_ABOUND]: [1], // race to the bush
  [MysteryEncounterType.CLOWNING_AROUND]: [1], // remain unprovoked
  [MysteryEncounterType.PART_TIMER]: [0],
  [MysteryEncounterType.DANCING_LESSONS]: [1], // learn its dance
  [MysteryEncounterType.WEIRD_DREAM]: [0],
  [MysteryEncounterType.THE_WINSTRATE_CHALLENGE]: [1], // refuse: full heal and a Rarer Candy
  [MysteryEncounterType.TELEPORTING_HIJINKS]: [0], // pay
  [MysteryEncounterType.BUG_TYPE_SUPERFAN]: [1, 2, 0], // show bug types, else give a bug item, else battle
  [MysteryEncounterType.FUN_AND_GAMES]: [1], // leave
  [MysteryEncounterType.UNCOMMON_BREED]: [2, 1, 0], // befriend, else feed, else battle
  [MysteryEncounterType.GLOBAL_TRADE_SYSTEM]: [3], // leave
  [MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER]: [0],
};
