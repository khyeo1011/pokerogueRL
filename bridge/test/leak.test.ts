// Leak test for the observation layer (issue #6): on a fixed game state, re-roll everything about the
// enemies that a player cannot see (IVs, nature, exact stats and HP within the same HP-bar pixel,
// unrevealed moves and abilities, unseen trainer Pokémon, the RNG seed) and check that the observation
// does not change. A builder that leaks a hidden field must fail the same check. At a mystery encounter's
// menus, re-seeding the RNG (which decides the outcomes, rolled after the choice) must not change the
// observation either, and observing must not draw from the RNG. Run with scripts/test_bridge.sh.

import type { BattleScene } from "#app/battle-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { allAbilities } from "#data/data-lists";
import { BattleType } from "#enums/battle-type";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import type { EnemyPokemon } from "#field/pokemon";
import { PokemonMove } from "#moves/pokemon-move";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Driver } from "../driver";
import { buildObservation, type Observation } from "../observation";
import { defaultPolicy } from "../policy";
import type { RevealTracker } from "../reveal-tracker";
import { startClassicRun } from "../run";
import { observationDiff } from "./observation-helpers";

const STARTERS = [SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR];
/** Moves to swap in for unrevealed ones. */
const FILLER_MOVES = [MoveId.SPLASH, MoveId.TACKLE, MoveId.GROWL, MoveId.EMBER, MoveId.SURF, MoveId.PSYCHIC, MoveId.TOXIC];
/** Species to swap in for trainer Pokémon not sent out yet. */
const FILLER_SPECIES = [SpeciesId.MEWTWO, SpeciesId.MAGIKARP, SpeciesId.SNORLAX];

type Builder = (scene: BattleScene, tracker: RevealTracker) => Observation;

const fairBuilder: Builder = (scene, tracker) => buildObservation(scene, tracker, { kind: "command", fieldIndex: 0 });

/** Deterministic pseudo-random integers in [0, n). */
function makeRand(seed: number): (n: number) => number {
  let s = seed;
  return n => {
    s = (s * 48271) % 2147483647;
    return s % n;
  };
}

/** Width in pixels of the HP bar the observation quantizes to (see bridge/observation.ts). */
function barWidth(p: EnemyPokemon): number {
  return p.isBoss() ? 86 : 48;
}

function barPixels(hp: number, maxHp: number, width: number): number {
  return hp > 0 ? Math.ceil((hp / maxHp) * width) : 0;
}

/**
 * Re-roll every hidden property of the enemy party in place. Each re-rolled value differs from the old one,
 * so a builder that copies it out shows a difference.
 */
function rerollHidden(scene: BattleScene, tracker: RevealTracker, rand: (n: number) => number): void {
  const battle = scene.currentBattle;
  // RNG state and seeds.
  scene.setSeed(`reroll-${rand(1e9)}`);
  scene.resetSeed();
  battle.battleSeed = `reroll-${rand(1e9)}`;

  for (const p of scene.getEnemyParty()) {
    const seen = p.isOnField() || battle.seenEnemyPartyMemberIds.has(p.id);
    if (!seen) {
      // A trainer Pokémon not sent out yet: even its species and level are hidden.
      const species = FILLER_SPECIES.filter(s => s !== p.species.speciesId);
      p.species = speciesDataRegistry.getSpecies(species[rand(species.length)]);
      p.formIndex = 0;
      p.level += 1 + rand(10);
    }

    // Unrevealed abilities.
    if (tracker.ability(p) == null) {
      p.customPokemonData.ability = differentAbility(p.getAbility().id, rand);
    }
    if (tracker.passive(p) == null) {
      p.customPokemonData.passive = differentAbility(p.getPassiveAbility().id, rand);
    }

    // Unrevealed moves; revealed ones keep their slot and PP.
    const revealed = new Set(tracker.moves(p).map(m => m.moveId));
    const fillers = FILLER_MOVES.filter(m => !p.moveset.some(pm => pm.moveId === m));
    p.moveset = p.moveset.map(m => (revealed.has(m.moveId) ? m : new PokemonMove(fillers.splice(rand(fillers.length), 1)[0])));

    // Hidden status counters.
    if (p.status) {
      p.status.toxicTurnCount += 1;
      p.status.sleepTurnsRemaining = (p.status.sleepTurnsRemaining ?? 0) + 1;
    }

    // IVs, nature, and so exact stats. Keep HP in the same HP-bar pixel, at a different exact value if any.
    const width = barWidth(p);
    const pixels = barPixels(p.hp, p.getMaxHp(), width);
    const oldHp = p.hp;
    let candidates: number[] = [];
    for (let tries = 0; candidates.length === 0; tries++) {
      if (tries === 50) {
        throw new Error(`no HP in bar pixel ${pixels} for ${p.name} after ${tries} re-rolls`);
      }
      p.ivs = p.ivs.map(iv => (iv + 1 + rand(31)) % 32);
      p.nature = (p.getNature() + 1 + rand(24)) % 25;
      if (p.customPokemonData.nature !== -1) {
        p.customPokemonData.nature = p.nature;
      }
      p.calculateStats();
      const maxHp = p.getMaxHp();
      candidates = Array.from({ length: maxHp + 1 }, (_, h) => h).filter(
        h => barPixels(h, maxHp, width) === pixels && (pixels > 0 || h === 0),
      );
    }
    const others = candidates.filter(h => h !== oldHp);
    p.hp = others.length > 0 ? others[rand(others.length)] : candidates[0];
  }
}

function differentAbility(current: number, rand: (n: number) => number): number {
  let id = current;
  while (id === current || id === 0) {
    id = rand(allAbilities.length);
  }
  return id;
}

/** Build, re-roll the hidden enemy data, build again, and return where the two observations differ. */
function leakDiff(scene: BattleScene, tracker: RevealTracker, build: Builder, seed: number): string[] {
  const before = build(scene, tracker);
  rerollHidden(scene, tracker, makeRand(seed));
  return observationDiff(before, build(scene, tracker));
}

/** Builders that each leak one hidden field, to show the check catches it. */
const leakyBuilders: Record<string, Builder> = {
  ivs: (scene, tracker) => {
    const obs = fairBuilder(scene, tracker);
    obs.battle.enemies.forEach((e, i) => Object.assign(e, { ivs: [...scene.getEnemyField()[i].ivs] }));
    return obs;
  },
  nature: (scene, tracker) => {
    const obs = fairBuilder(scene, tracker);
    obs.battle.enemies.forEach((e, i) => Object.assign(e, { nature: scene.getEnemyField()[i].getNature() }));
    return obs;
  },
  "exact HP": (scene, tracker) => {
    const obs = fairBuilder(scene, tracker);
    obs.battle.enemies.forEach((e, i) => Object.assign(e, { hpExact: scene.getEnemyField()[i].hp }));
    return obs;
  },
  "full moveset": (scene, tracker) => {
    const obs = fairBuilder(scene, tracker);
    obs.battle.enemies.forEach((e, i) =>
      Object.assign(e, { moves: scene.getEnemyField()[i].moveset.map(m => m.moveId) }),
    );
    return obs;
  },
  ability: (scene, tracker) => {
    const obs = fairBuilder(scene, tracker);
    obs.battle.enemies.forEach((e, i) => Object.assign(e, { abilityId: scene.getEnemyField()[i].getAbility().id }));
    return obs;
  },
  seed: (scene, tracker) => Object.assign(fairBuilder(scene, tracker), { seed: scene.seed }),
};

describe("observation leak test", () => {
  let phaserGame: Phaser.Game;
  let tracker: RevealTracker | undefined;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    tracker?.dispose();
    tracker = undefined;
  });

  /**
   * Boot a run with evenly matched levels and play until the enemy has taken damage and revealed a move,
   * so the state has a partly revealed moveset and HP between full and empty.
   */
  async function bootDamagedEnemy(seed: string, trainer = false) {
    const game = new GameManager(phaserGame);
    game.override.startingLevel(50).enemyLevel(50);
    if (trainer) {
      game.override.battleType(BattleType.TRAINER);
    }
    await startClassicRun(game, seed, ...STARTERS);
    const scene = game.scene;
    const driver = new Driver(game);
    tracker = driver.tracker;
    for (;;) {
      const decision = await driver.next();
      if (decision.kind === "target") {
        driver.act({ kind: "target", target: scene.getEnemyField().find(e => e.isActive(true))!.getBattlerIndex() });
        continue;
      }
      if (decision.kind !== "command") {
        throw new Error(`unexpected decision ${decision.kind}`);
      }
      const enemy = scene.getEnemyField()[0];
      if (enemy.hp < enemy.getMaxHp() && tracker.moves(enemy).length > 0) {
        return { scene, tracker };
      }
      // Weakest damaging move, so the fight lasts.
      const pokemon = scene.getPlayerField()[decision.fieldIndex];
      const moveset = pokemon.getMoveset();
      const usable = moveset.filter(m => m.isUsable(pokemon)[0] && m.getMove().power > 0);
      const move = usable.reduce((a, b) => (b.getMove().power < a.getMove().power ? b : a));
      driver.act({ kind: "move", slot: moveset.indexOf(move) });
    }
  }

  it("re-rolling hidden enemy data leaves the observation unchanged", { timeout: 60_000 }, async () => {
    const { scene, tracker } = await bootDamagedEnemy("leak-wild");
    const enemy = scene.getEnemyField()[0];
    const before = { ivs: [...enemy.ivs], nature: enemy.getNature(), hp: enemy.hp, maxHp: enemy.getMaxHp() };

    for (let round = 1; round <= 5; round++) {
      expect(leakDiff(scene, tracker, fairBuilder, round)).toEqual([]);
    }
    // The re-rolls really changed the hidden data.
    expect(enemy.ivs).not.toEqual(before.ivs);
    expect(enemy.getNature()).not.toBe(before.nature);
    expect([enemy.hp, enemy.getMaxHp()]).not.toEqual([before.hp, before.maxHp]);
    expect(fairBuilder(scene, tracker).battle.enemies[0].revealedMoves.length).toBeGreaterThan(0);
  });

  it("also hides a trainer's Pokémon that were not sent out", { timeout: 60_000 }, async () => {
    const { scene, tracker } = await bootDamagedEnemy("leak-trainer", true);
    const obs = fairBuilder(scene, tracker);
    expect(obs.battle.trainer).not.toBeNull();
    console.info(`trainer party: ${scene.getEnemyParty().length}, unseen: ${obs.battle.trainer!.party.filter(b => b.seenSpeciesId == null).length}`);
    for (let round = 1; round <= 5; round++) {
      expect(leakDiff(scene, tracker, fairBuilder, round)).toEqual([]);
    }
  });

  it.each(Object.keys(leakyBuilders))("catches a builder that leaks the enemy's %s", async name => {
    const { scene, tracker } = await bootDamagedEnemy("leak-wild");
    expect(leakDiff(scene, tracker, leakyBuilders[name], 1)).not.toEqual([]);
  });

  // Options whose outcome is rolled after the choice (the chest), that start a battle, or that open a party
  // screen (mePokemon) and then a menu (meSubOption: Training Session's nature).
  it.each([
    { type: MysteryEncounterType.MYSTERIOUS_CHEST, option: 0 },
    { type: MysteryEncounterType.FIGHT_OR_FLIGHT, option: 0 },
    { type: MysteryEncounterType.TRAINING_SESSION, option: 1 },
    { type: MysteryEncounterType.SHADY_VITAMIN_DEALER, option: 0 },
  ])("a mystery encounter's menus show no outcome (type $type)", { timeout: 60_000 }, async ({ type, option }) => {
    const game = new GameManager(phaserGame);
    game.override.startingWave(41).startingBiome(BiomeId.CAVE).startingLevel(100).disableTrainerWaves();
    await startClassicRun(game, `leak-me-${type}`, ...STARTERS);
    game.override.mysteryEncounterChance(100).mysteryEncounter(type);
    const scene = game.scene;
    scene.money = 100_000;
    const driver = new Driver(game);
    tracker = driver.tracker;
    const checked: string[] = [];
    for (;;) {
      const decision = await driver.next();
      if (decision.kind === "gameOver" || scene.currentBattle.waveIndex > 42) {
        break;
      }
      const encounterStage =
        decision.kind === "mysteryEncounter" || decision.kind === "mePokemon" || decision.kind === "meSubOption";
      if (encounterStage) {
        game.override.mysteryEncounterChance(0);
        const rng = Phaser.Math.RND.state();
        const before = driver.observe();
        expect(Phaser.Math.RND.state(), "observing draws from the RNG").toBe(rng);
        scene.setSeed(`leak-me-reroll-${checked.length}`);
        scene.resetSeed();
        expect(observationDiff(before, driver.observe())).toEqual([]);
        checked.push(decision.kind);
      }
      const first = decision.kind === "mysteryEncounter" && checked.length === 1;
      driver.act(first ? { kind: "meOption", index: option } : defaultPolicy(driver.observe(), decision.legal));
    }
    console.info(`type ${type}: checked ${checked.join(", ")}`);
    expect(checked[0]).toBe("mysteryEncounter");
  });
});
