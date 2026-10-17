// Scripted default policy (issue #7): a simple answer to every decision so that runs complete. It uses
// only what the player can see (own moves and party, enemy species and types), never enemy IVs, exact
// HP or damage rolls, since issue #10 moves policies onto the observation layer.
//
// Battles: the usable move with the highest base power × STAB × type effectiveness against the visible
// enemy types; never switches voluntarily, throws balls or runs. Rewards: the first free reward that can
// be taken (so the item-target and learn-move screens get used), first legal target. New moves replace
// the weakest known move. First biome, evolutions go ahead, caught Pokémon are not kept over the party.
// Mystery encounters: a preferred option per encounter type (ENCOUNTER_PREFERENCES), else the first
// legal one; the first legal Pokémon and follow-up entry.

import type { BattleScene } from "#app/battle-scene";
import { allMoves } from "#data/data-lists";
import { getTypeDamageMultiplier } from "#data/type";
import { BattlerIndex } from "#enums/battler-index";
import { MoveCategory } from "#enums/move-category";
import type { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import type { Pokemon } from "#field/pokemon";
import type { Action, ActionOf, Decision } from "./decisions";

/** Base power × STAB × type effectiveness of `moveId` used by `user` on `target` (0 for status moves). */
function moveScore(user: Pokemon, moveId: MoveId, target?: Pokemon): number {
  const move = allMoves[moveId];
  if (move.category === MoveCategory.STATUS || move.power <= 0) {
    return 0;
  }
  const type = user.getMoveType(move);
  const stab = user.getTypes().includes(type) ? 1.5 : 1;
  const effectiveness = target?.getTypes().reduce((m, t) => m * getTypeDamageMultiplier(type, t), 1) ?? 1;
  return move.power * stab * effectiveness;
}

/** The legal action with the highest score (the first on ties). */
function best<A extends Action>(actions: A[], score: (a: A) => number): A {
  return actions.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** The default action for a decision. Always one of `decision.legal`. */
export function defaultAction(scene: BattleScene, decision: Exclude<Decision, { kind: "gameOver" }>): Action {
  switch (decision.kind) {
    case "command": {
      const pokemon = scene.getPlayerField()[decision.fieldIndex];
      const enemies = scene.getEnemyField().filter(e => e.isActive(true));
      const moves = decision.legal.filter((a): a is ActionOf<"move"> => a.kind === "move" && !a.tera);
      return best(moves, a => {
        const moveId = pokemon.getMoveset()[a.slot]?.moveId;
        return moveId === undefined ? 0 : Math.max(0, ...enemies.map(e => moveScore(pokemon, moveId, e)));
      });
    }
    case "target": {
      const user = scene.getPlayerField()[decision.fieldIndex];
      const field = scene.getField();
      // Enemies before allies, then the best effectiveness.
      return best(decision.legal, a =>
        a.target >= BattlerIndex.ENEMY ? 1 + moveScore(user, decision.moveId, field[a.target]) : 0,
      );
    }
    case "checkSwitch":
      return { kind: "stay" };
    case "reward":
      return decision.legal.find(a => a.kind === "reward") ?? { kind: "skipReward" };
    case "learnMove": {
      const pokemon = scene.getPlayerParty()[decision.partySlot];
      const moveset = pokemon.getMoveset();
      // Lowest base power × STAB, regardless of the enemy.
      return best(decision.legal, a =>
        a.kind === "learnMove" ? -moveScore(pokemon, moveset[a.forget].moveId) : Number.NEGATIVE_INFINITY,
      );
    }
    case "evolution":
      return { kind: "evolve" };
    case "partyFull":
      return { kind: "keepParty" };
    case "switch":
    case "itemTarget":
    case "biome":
    case "revive":
      return decision.legal[0];
    case "mysteryEncounter":
    case "mePokemon":
    case "meSubOption":
      return defaultEncounterAction(decision);
  }
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

/** Mystery encounters: the preferred legal option (follow-up menus: the first), first Pokémon and entry. */
function defaultEncounterAction(decision: Extract<Decision, { kind: "mysteryEncounter" | "mePokemon" | "meSubOption" }>): Action {
  if (decision.kind === "mysteryEncounter" && !decision.followUp) {
    const preferred = ENCOUNTER_PREFERENCES[decision.encounterType]
      .map(index => decision.legal.find(a => a.index === index))
      .find(a => a !== undefined);
    if (preferred) {
      return preferred;
    }
  }
  return decision.legal[0];
}
