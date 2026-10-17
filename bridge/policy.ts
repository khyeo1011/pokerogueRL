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
// kept over the party.

import { BattlerIndex } from "#enums/battler-index";
import { MoveCategory } from "#enums/move-category";
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
    case "switch":
    case "itemTarget":
    case "biome":
    case "revive":
    case "mysteryEncounter":
      return legal[0];
  }
};
