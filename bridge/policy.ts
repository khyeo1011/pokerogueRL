// Scripted default policy (issue #7): a simple answer to every decision so that runs complete. It uses
// only what the player can see (own moves and party, enemy species and types), never enemy IVs, exact
// HP or damage rolls, since issue #10 moves policies onto the observation layer.
//
// Battles: the usable move with the highest base power × STAB × type effectiveness against the visible
// enemy types; never switches voluntarily, throws balls or runs. Rewards: the first free reward that can
// be taken (so the item-target and learn-move screens get used), first legal target. New moves replace
// the weakest known move. First biome, evolutions go ahead, caught Pokémon are not kept over the party.

import type { BattleScene } from "#app/battle-scene";
import { allMoves } from "#data/data-lists";
import { getTypeDamageMultiplier } from "#data/type";
import { BattlerIndex } from "#enums/battler-index";
import { MoveCategory } from "#enums/move-category";
import type { MoveId } from "#enums/move-id";
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
  }
}
