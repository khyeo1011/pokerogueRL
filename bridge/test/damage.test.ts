// Checks bridge/damage.ts: hand-computed matchups on built observations, then the estimate against the
// game's own damage calculation (Pokemon.getAttackDamage, which tests may call) in real battles, with the
// hidden parts the estimate cannot see pinned: enemy IVs near the expected value, a neutral nature, and
// abilities without damage effects. Run with scripts/test_bridge.sh.

import { allMoves } from "#data/data-lists";
import { AbilityId } from "#enums/ability-id";
import { MoveCategory } from "#enums/move-category";
import { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { WeatherType } from "#enums/weather-type";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { estimateDamage, estimateEnemyStats, expectedEnemyIv } from "../damage";
import { buildObservation, type EnemyPokemonObs, type Observation, type OwnPokemonObs } from "../observation";
import { RevealTracker } from "../reveal-tracker";

let phaserGame: Phaser.Game;

beforeAll(() => {
  phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
});

describe("estimateDamage on built observations", () => {
  // The static data is exported from the game's tables, which need a scene.
  beforeAll(() => {
    new GameManager(phaserGame);
  });

  const field = (statStages = [0, 0, 0, 0, 0, 0, 0]) => ({ statStages, tags: [] });

  /** A level 50 Fire type with 100 in every stat. */
  function user(over: Partial<OwnPokemonObs> = {}): OwnPokemonObs {
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
  function snorlax(over: Partial<EnemyPokemonObs> = {}): EnemyPokemonObs {
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

  function obs(battle: Partial<Observation["battle"]> = {}, wave = 10): Observation {
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

  // Wild Snorlax at level 50 with IV 15.5: HP floor((320 + 15.5) / 2) + 60 = 227, Def floor(145.5 / 2) + 5 = 77.
  // Tackle (40, physical Normal, no STAB): ((22 × 40 × 100) / 77 / 50 + 2) × 0.925 = 22.99, 10.13% of 227.
  const TACKLE = 22.993 / 227;

  it("estimates a wild enemy's stats from base stats, level and IV 15.5", () => {
    const stats = estimateEnemyStats(snorlax(), expectedEnemyIv(obs()));
    expect([stats[0], stats[2]]).toEqual([227, 77]);
  });

  it("matches a hand-computed hit", () => {
    expect(estimateDamage(obs(), user(), MoveId.TACKLE, snorlax())).toBeCloseTo(TACKLE, 4);
  });

  it("applies STAB and type effectiveness on the shown types", () => {
    const normal = user({ types: [PokemonType.NORMAL] });
    expect(estimateDamage(obs(), normal, MoveId.TACKLE, snorlax())).toBeCloseTo(TACKLE * 1.5, 4);
    const ghost = snorlax({ types: [PokemonType.GHOST] });
    expect(estimateDamage(obs(), user(), MoveId.TACKLE, ghost)).toBe(0);
  });

  it("applies both sides' stat stages", () => {
    // +2 Atk: 100 × 4/2 = 200. -2 Def: floor(77 × 2/4) = 38. ((22 × 40 × 200) / 38 / 50 + 2) × 0.925 = 87.53.
    const boosted = user({ field: field([2, 0, 0, 0, 0, 0, 0]) });
    const lowered = snorlax({ field: field([0, -2, 0, 0, 0, 0, 0]) });
    expect(estimateDamage(obs(), boosted, MoveId.TACKLE, lowered)).toBeCloseTo(87.53 / 227, 4);
  });

  it("applies weather to the move type", () => {
    const sun = obs({ weather: { type: WeatherType.SUNNY, turnsLeft: 5, maxTurns: 5 } });
    const rain = obs({ weather: { type: WeatherType.RAIN, turnsLeft: 5, maxTurns: 5 } });
    const ember = estimateDamage(obs(), user(), MoveId.EMBER, snorlax());
    expect(estimateDamage(sun, user(), MoveId.EMBER, snorlax())).toBeCloseTo(ember * 1.5, 6);
    expect(estimateDamage(rain, user(), MoveId.EMBER, snorlax())).toBeCloseTo(ember * 0.5, 6);
    expect(estimateDamage(sun, user(), MoveId.TACKLE, snorlax())).toBeCloseTo(TACKLE, 4);
  });

  it("is 0 for status moves and moves without a fixed power", () => {
    expect(estimateDamage(obs(), user(), MoveId.GROWL, snorlax())).toBe(0);
    expect(estimateDamage(obs(), user(), MoveId.SEISMIC_TOSS, snorlax())).toBe(0);
  });

  it("expects trainer IVs from floor(wave / 10) to 31", () => {
    const trainer = { trainerType: 0, variant: 0, party: [] };
    expect(expectedEnemyIv(obs())).toBe(15.5);
    expect(expectedEnemyIv(obs({ trainer }, 55))).toBe(18);
  });
});

describe("estimateDamage against the game's calculation", () => {
  let tracker: RevealTracker | undefined;

  afterEach(() => {
    tracker?.dispose();
    tracker = undefined;
  });

  interface Matchup {
    name: string;
    user: SpeciesId;
    move: MoveId;
    enemy: SpeciesId;
    fusion?: SpeciesId;
    weather?: WeatherType;
    /** Stat stages to set: the user's Atk/SpAtk and the enemy's Def/SpDef. */
    stages?: { user: number; enemy: number };
  }

  // Level 100 on both sides, so a stat point rounded away is well under the tolerance.
  const MATCHUPS: Matchup[] = [
    { name: "special, STAB, super effective", user: SpeciesId.CHARIZARD, move: MoveId.FLAMETHROWER, enemy: SpeciesId.VENUSAUR },
    { name: "physical, STAB, resisted", user: SpeciesId.SNORLAX, move: MoveId.BODY_SLAM, enemy: SpeciesId.AGGRON },
    { name: "rain on a Water move", user: SpeciesId.BLASTOISE, move: MoveId.SURF, enemy: SpeciesId.CHARIZARD, weather: WeatherType.RAIN },
    { name: "sun on a Water move", user: SpeciesId.BLASTOISE, move: MoveId.SURF, enemy: SpeciesId.SNORLAX, weather: WeatherType.SUNNY },
    { name: "sandstorm Sp. Def boost", user: SpeciesId.BLASTOISE, move: MoveId.HYDRO_PUMP, enemy: SpeciesId.TYRANITAR, weather: WeatherType.SANDSTORM },
    { name: "snow Def boost", user: SpeciesId.MACHAMP, move: MoveId.CLOSE_COMBAT, enemy: SpeciesId.GLALIE, weather: WeatherType.SNOW },
    { name: "fused enemy", user: SpeciesId.GARCHOMP, move: MoveId.EARTHQUAKE, enemy: SpeciesId.MAGNEZONE, fusion: SpeciesId.SNORLAX },
    { name: "stat stages", user: SpeciesId.GARCHOMP, move: MoveId.DRAGON_CLAW, enemy: SpeciesId.SNORLAX, stages: { user: 2, enemy: -1 } },
  ];

  it.each(MATCHUPS)("$name", async m => {
    const game = new GameManager(phaserGame);
    game.override
      .battleStyle("single")
      .startingLevel(100)
      .enemyLevel(100)
      .ability(AbilityId.BALL_FETCH)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset(m.move)
      .enemySpecies(m.enemy)
      // The estimate assumes IV 15.5 and a neutral nature for a wild enemy.
      .enemyIVs([15, 16, 15, 16, 15, 16])
      .enemyNature(Nature.HARDY)
      .criticalHits(false);
    if (m.fusion !== undefined) {
      game.override.enemyFusionSpecies(m.fusion);
    }
    if (m.weather !== undefined) {
      game.override.weather(m.weather);
    }
    await game.classicMode.startBattle(m.user);
    tracker = new RevealTracker(game.scene);

    const player = game.field.getPlayerPokemon();
    const enemy = game.field.getEnemyPokemon();
    const move = allMoves[m.move];
    if (m.stages) {
      const physical = move.category === MoveCategory.PHYSICAL;
      player.setStatStage(physical ? Stat.ATK : Stat.SPATK, m.stages.user);
      enemy.setStatStage(physical ? Stat.DEF : Stat.SPDEF, m.stages.enemy);
    }

    // Simulated calls skip the random roll; the estimate averages it.
    const maxHp = enemy.getMaxHp();
    const actual = (enemy.getAttackDamage({ source: player, move }).damage * 0.925) / maxHp;
    const obs = buildObservation(game.scene, tracker, { kind: "command", fieldIndex: 0 });
    const estimate = estimateDamage(obs, obs.party[0], m.move, obs.battle.enemies[0]);
    console.info(`${m.name}: estimate ${estimate.toFixed(4)}, game ${actual.toFixed(4)}`);
    expect(actual).toBeGreaterThan(0);
    // The game rounds damage down to whole HP; the estimate does not.
    expect(Math.abs(estimate - actual)).toBeLessThan(0.02 * actual + 1 / maxHp);
  });
});
