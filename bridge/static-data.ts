// Public game knowledge as plain JSON (issue #5): species typing, base stats and possible abilities, move
// data, and the type chart. Every player can look these up, so the policy may too, but they are the same on
// every step, so observations (bridge/observation.ts) carry only IDs into these tables.

import { allMoves } from "#data/data-lists";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { getTypeDamageMultiplier } from "#data/type";
import { PokemonType } from "#enums/pokemon-type";

export interface SpeciesFormData {
  formIndex: number;
  types: number[];
  /** [HP, Atk, Def, SpAtk, SpDef, Spd]. */
  baseStats: number[];
  /** [ability 1, ability 2, hidden ability]; AbilityId.NONE (0) where a species has none. */
  abilities: number[];
}

export interface SpeciesData {
  speciesId: number;
  /** One entry per form; a single form 0 for species without forms. */
  forms: SpeciesFormData[];
}

export interface MoveData {
  moveId: number;
  type: number;
  /** MoveCategory: 0 physical, 1 special, 2 status. */
  category: number;
  /** -1 for moves without a fixed power. */
  power: number;
  /** -1 for moves that never miss. */
  accuracy: number;
  pp: number;
  priority: number;
  /** MoveTarget. */
  target: number;
}

export interface StaticData {
  species: SpeciesData[];
  moves: MoveData[];
  /** typeChart[attack][defend] for the 18 regular types (PokemonType.NORMAL = 0 .. FAIRY = 17). */
  typeChart: number[][];
}

/** Export the static game data that observation IDs refer to. */
export function exportStaticData(): StaticData {
  const species = speciesDataRegistry.getAllSpecies().map(s => ({
    speciesId: s.speciesId,
    forms: (s.forms?.length ? s.forms : [s]).map(f => ({
      formIndex: f.formIndex,
      types: f.type2 == null ? [f.type1] : [f.type1, f.type2],
      baseStats: [...f.baseStats],
      abilities: [f.ability1, f.ability2, f.abilityHidden],
    })),
  }));
  const moves = allMoves.map(m => ({
    moveId: m.id,
    type: m.type,
    category: m.category,
    power: m.power,
    accuracy: m.accuracy,
    pp: m.pp,
    priority: m.priority,
    target: m.moveTarget,
  }));
  const types = Array.from({ length: PokemonType.FAIRY + 1 }, (_, t) => t);
  const typeChart = types.map(atk => types.map(def => getTypeDamageMultiplier(atk, def)));
  return { species, moves, typeChart };
}
