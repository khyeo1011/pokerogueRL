// Damage estimate from visible data (issue #13): the expected damage of a player's move on an enemy, as a
// fraction of the enemy's HP bar, from the observation and public static data alone. The game's own damage
// calculation reads the enemy's hidden stats, so policies may not call it; this module is held to the same
// import rules as a policy (bridge/test/policy-imports.test.ts).
//
// It follows the game's damage formula (Pokemon in src/field/pokemon.ts) for what a player can see: own
// exact stats, move power, type and category, STAB, the type chart on the enemy's shown types, weather,
// and both sides' stat stages. Enemy stats come from base stats and level, as calculateStats() makes
// them, with a neutral nature and the expected IV, since enemy IVs and natures are hidden. The random roll
// is averaged. Left out: crits, abilities, held items, burn, screens, Tera STAB, and moves without a
// fixed power (estimated as 0).

import { MoveCategory } from "#enums/move-category";
import { PokemonType } from "#enums/pokemon-type";
import { WeatherType } from "#enums/weather-type";
import type { EnemyPokemonObs, Observation, OwnPokemonObs } from "./observation";
import { exportStaticData, type SpeciesFormData, type StaticData } from "./static-data";

/** Mean of the game's random damage roll, a whole percentage from 85 to 100. */
const MEAN_DAMAGE_ROLL = 0.925;

let staticData: StaticData | undefined;
let speciesById: Map<number, SpeciesFormData[]> | undefined;

/** The static tables, exported on first use (the game's data is loaded by then). */
export function data(): StaticData {
  staticData ??= exportStaticData();
  return staticData;
}

/** Type effectiveness of an attack type on a defender's types (1 for types outside the chart). */
export function effectiveness(attackType: number, defenderTypes: readonly number[]): number {
  const chart = data().typeChart;
  return defenderTypes.reduce((m, t) => m * (chart[attackType]?.[t] ?? 1), 1);
}

/** Base stats of a species form, [HP, Atk, Def, SpAtk, SpDef, Spd]. */
function baseStats(speciesId: number, formIndex: number): number[] {
  speciesById ??= new Map(data().species.map(s => [s.speciesId, s.forms]));
  const forms = speciesById.get(speciesId)!;
  return (forms.find(f => f.formIndex === formIndex) ?? forms[0]).baseStats;
}

/**
 * The expected IV of an enemy. Wild IVs come from the Pokémon's random ID, uniform over 0..31; trainer
 * Pokémon roll each IV from floor(wave / 10) to 31 (EnemyPokemon's constructor).
 */
export function expectedEnemyIv(obs: Observation): number {
  return obs.battle.trainer ? (Math.floor(obs.run.wave / 10) + 31) / 2 : 15.5;
}

/**
 * Estimated stats of an enemy, [HP, Atk, Def, SpAtk, SpDef, Spd], as Pokemon.calculateStats() makes them
 * from its shown species (averaged with the fusion's, as the game does), level and `iv`, with a neutral
 * nature.
 */
export function estimateEnemyStats(enemy: EnemyPokemonObs, iv: number): number[] {
  let base = baseStats(enemy.speciesId, enemy.formIndex);
  if (enemy.fusionSpeciesId !== null) {
    const fusion = baseStats(enemy.fusionSpeciesId, enemy.fusionFormIndex ?? 0);
    base = base.map((b, s) => Math.ceil((b + fusion[s]) / 2));
  }
  return base.map((b, s) => {
    const stat = Math.floor(((2 * b + iv) * enemy.level) / 100);
    return s === 0 ? stat + enemy.level + 10 : stat + 5;
  });
}

/** A stat after its stage (-6..6), as Pokemon.getStatStageMultiplier() and getEffectiveStat() apply it. */
function staged(stat: number, stage: number): number {
  return Math.max(Math.floor((stat * Math.max(2, 2 + stage)) / Math.max(2, 2 - stage)), 1);
}

/** Damage multiplier of the weather on an attack type (getWeatherMultiplierForMove). */
function weatherMultiplier(weather: number | undefined, moveType: number): number {
  switch (weather) {
    case WeatherType.SUNNY:
    case WeatherType.HARSH_SUN:
      return moveType === PokemonType.FIRE ? 1.5 : moveType === PokemonType.WATER ? 0.5 : 1;
    case WeatherType.RAIN:
    case WeatherType.HEAVY_RAIN:
      return moveType === PokemonType.WATER ? 1.5 : moveType === PokemonType.FIRE ? 0.5 : 1;
    default:
      return 1;
  }
}

/**
 * Expected damage of `moveId` used by `user` on `target`, as a fraction of the target's full HP bar (1 is
 * a one-hit KO from full HP). 0 for status moves and moves without a fixed power.
 */
export function estimateDamage(
  obs: Observation,
  user: OwnPokemonObs,
  moveId: number,
  target: EnemyPokemonObs,
): number {
  const move = data().moves[moveId];
  if (move.category === MoveCategory.STATUS || move.power <= 0) {
    return 0;
  }
  const physical = move.category === MoveCategory.PHYSICAL;
  const enemyStats = estimateEnemyStats(target, expectedEnemyIv(obs));
  const weather = obs.battle.weather?.type;

  // Stat stages are indexed from Atk, stats from HP.
  const [atkStat, defStat] = physical ? [1, 2] : [3, 4];
  const attack = staged(user.stats[atkStat], user.field.statStages[atkStat - 1]);
  let defense = staged(enemyStats[defStat], target.field.statStages[defStat - 1]);
  // Snow raises Ice types' Defense, sandstorm Rock types' Sp. Def (getEffectiveStat).
  if (
    (physical && weather === WeatherType.SNOW && target.types.includes(PokemonType.ICE))
    || (!physical && weather === WeatherType.SANDSTORM && target.types.includes(PokemonType.ROCK))
  ) {
    defense = Math.floor(defense * 1.5);
  }

  const base = (((2 * user.level) / 5 + 2) * move.power * attack) / defense / 50 + 2;
  const stab = user.types.includes(move.type) ? 1.5 : 1;
  const damage =
    base
    * weatherMultiplier(weather, move.type)
    * stab
    * effectiveness(move.type, target.types)
    * MEAN_DAMAGE_ROLL;
  return damage / enemyStats[0];
}
