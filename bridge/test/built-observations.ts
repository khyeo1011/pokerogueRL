// Observations built by hand for tests of policy-side code (bridge/damage.ts, bridge/policy.ts): a player
// Pokémon, an enemy and the observation around them, with fields overridable per test.

import { AbilityId } from "#enums/ability-id";
import { Nature } from "#enums/nature";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import type { EnemyPokemonObs, Observation, OwnPokemonObs } from "../observation";

export const field = (statStages = [0, 0, 0, 0, 0, 0, 0]) => ({ statStages, tags: [] });

/** A level 50 Fire type with 100 in every stat. */
export function user(over: Partial<OwnPokemonObs> = {}): OwnPokemonObs {
  return {
    speciesId: SpeciesId.CHARMANDER,
    formIndex: 0,
    fusionSpeciesId: null,
    fusionFormIndex: null,
    level: 50,
    exp: 0,
    expToNext: 0,
    gender: 0,
    shiny: false,
    nature: Nature.HARDY,
    abilityId: AbilityId.BALL_FETCH,
    passiveAbilityId: null,
    teraType: PokemonType.FIRE,
    terastallized: false,
    types: [PokemonType.FIRE],
    hp: 100,
    stats: [100, 100, 100, 100, 100, 100],
    ivs: [31, 31, 31, 31, 31, 31],
    status: 0,
    pokerus: false,
    friendship: 0,
    luck: 0,
    moves: [],
    items: [],
    fieldIndex: 0,
    field: field(),
    ...over,
  };
}

/** A level 50 Snorlax (base HP 160, Def 65, SpDef 110). */
export function snorlax(over: Partial<EnemyPokemonObs> = {}): EnemyPokemonObs {
  return {
    fieldIndex: 0,
    speciesId: SpeciesId.SNORLAX,
    formIndex: 0,
    fusionSpeciesId: null,
    fusionFormIndex: null,
    level: 50,
    gender: 0,
    shiny: false,
    types: [PokemonType.NORMAL],
    terastallized: false,
    teraType: null,
    hp: 1,
    bossSegments: 0,
    bossSegmentIndex: 0,
    status: 0,
    field: field(),
    items: [],
    revealedMoves: [],
    revealedAbilityId: null,
    revealedPassiveId: null,
    ...over,
  };
}

export function obs(battle: Partial<Observation["battle"]> = {}, wave = 10): Observation {
  return {
    stage: { kind: "command", fieldIndex: 0 },
    run: { wave, biomeId: 0, money: 0, pokeballs: [], modifiers: [] },
    party: [],
    battle: {
      battleType: 0,
      double: false,
      turn: 1,
      weather: null,
      terrain: null,
      arenaTags: [],
      trainer: null,
      enemyModifiers: [],
      enemies: [],
      ...battle,
    },
  };
}
