// Tracks what the player has seen of each enemy Pokémon's moves and abilities during a run (issue #5).
// The observation may only show an enemy's moves and ability once the game has revealed them, and the
// game keeps no complete record of that, so this listens to the same signals the UI does:
//   - Moves: the MOVE_USED event on scene.eventTarget, which the enemy battle-info flyout uses to list
//     an enemy's moves with their PP ("Tackle 34/35"). It fires when PP is spent, and for moves revealed by
//     Forewarn, Grudge and PP-reducing moves (Spite, Eerie Spell). Struggle is ignored, as in the flyout.
//   - Abilities: Pokemon.revealAbility(), which the game calls after an ability popup (ShowAbilityPhase) and
//     when Frisk or Trace names an ability in a message. waveData.abilityRevealed is not enough: it is reset
//     every wave and is also set when only the passive was shown, so the popup's passive flag is read here.

import type { BattleScene } from "#app/battle-scene";
import { MoveId } from "#enums/move-id";
import type { MoveUsedEvent } from "#events/battle-scene";
import { BattleSceneEventType } from "#events/battle-scene";
import { Pokemon } from "#field/pokemon";

/** A move the player has seen an enemy use, with the PP the flyout shows as used. */
export interface RevealedMove {
  moveId: MoveId;
  ppUsed: number;
}

/** What has been revealed about one Pokémon. */
interface Revealed {
  moves: RevealedMove[];
  ability: number | null;
  passive: number | null;
}

/** The tracker that Pokemon.revealAbility() reports to. One game runs per process. */
let activeTracker: RevealTracker | null = null;

// Installed once per module instance. Upstream's revealAbility only sets waveData.abilityRevealed.
const revealAbility = Pokemon.prototype.revealAbility;
Pokemon.prototype.revealAbility = function (this: Pokemon): void {
  activeTracker?.onAbilityRevealed(this);
  revealAbility.call(this);
};

/**
 * Per-run record of enemy moves and abilities revealed so far, keyed by `Pokemon.id` (unique per Pokémon,
 * stable across switches and waves). Create one per run, after the run boots and before the first phase
 * runs (e.g. next to `new Driver(game)`), and {@linkcode dispose} it when the run ends.
 */
export class RevealTracker {
  private readonly revealed = new Map<number, Revealed>();
  private readonly onMoveUsed = (event: Event) => {
    const { pokemonId, move, ppUsed } = event as MoveUsedEvent;
    if (move.id === MoveId.STRUGGLE) {
      return;
    }
    const moves = this.get(pokemonId).moves;
    const known = moves.find(m => m.moveId === move.id);
    if (known) {
      known.ppUsed = ppUsed;
    } else {
      moves.push({ moveId: move.id, ppUsed });
    }
  };

  constructor(private readonly scene: BattleScene) {
    scene.eventTarget.addEventListener(BattleSceneEventType.MOVE_USED, this.onMoveUsed);
    activeTracker = this;
  }

  /** Stop listening. */
  dispose(): void {
    this.scene.eventTarget.removeEventListener(BattleSceneEventType.MOVE_USED, this.onMoveUsed);
    if (activeTracker === this) {
      activeTracker = null;
    }
  }

  /** Moves `pokemon` has been seen to use, in the order they were first seen. */
  moves(pokemon: Pokemon): RevealedMove[] {
    return this.revealed.get(pokemon.id)?.moves ?? [];
  }

  /** The ability last revealed for `pokemon`, or `null` if none has been. */
  ability(pokemon: Pokemon): number | null {
    return this.revealed.get(pokemon.id)?.ability ?? null;
  }

  /** The passive ability last revealed for `pokemon`, or `null` if none has been. */
  passive(pokemon: Pokemon): number | null {
    return this.revealed.get(pokemon.id)?.passive ?? null;
  }

  /** Called by the revealAbility() hook. */
  onAbilityRevealed(pokemon: Pokemon): void {
    const phase = this.scene.phaseManager.getCurrentPhase();
    // ShowAbilityPhase calls revealAbility() for passives too; only its own flag says which was shown.
    const passive = phase?.is("ShowAbilityPhase") && phase.getPokemon() === pokemon && phase["passive"] === true;
    if (passive) {
      this.get(pokemon.id).passive = pokemon.getPassiveAbility().id;
    } else {
      this.get(pokemon.id).ability = pokemon.getAbility().id;
    }
  }

  private get(pokemonId: number): Revealed {
    let entry = this.revealed.get(pokemonId);
    if (entry == null) {
      entry = { moves: [], ability: null, passive: null };
      this.revealed.set(pokemonId, entry);
    }
    return entry;
  }
}
