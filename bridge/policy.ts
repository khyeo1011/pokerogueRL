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
// randomPolicy (issue #53) picks uniformly among the legal actions, to hunt game bugs; replayPolicy plays
// back recorded actions.

import { BattlerIndex } from "#enums/battler-index";
import { MoveCategory } from "#enums/move-category";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import type { Action, ActionOf } from "./decisions";
import type { Observation, OwnPokemonObs } from "./observation";
import { exportStaticData, type StaticData } from "./static-data";

/**
 * Chooses an action for a decision from its observation (`Driver.observe()`) and legal actions
 * (`decision.legal`). Must return one of `legal`.
 */
export type Policy = (obs: Observation, legal: readonly Action[]) => Action;

let staticData: StaticData | undefined;

/** The static tables, exported on first use (the game's data is loaded by then). */
function data(): StaticData {
  staticData ??= exportStaticData();
  return staticData;
}

/** Type effectiveness of an attack type on a defender's types (1 for types outside the chart). */
function effectiveness(attackType: number, defenderTypes: readonly number[]): number {
  const chart = data().typeChart;
  return defenderTypes.reduce((m, t) => m * (chart[attackType]?.[t] ?? 1), 1);
}

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
