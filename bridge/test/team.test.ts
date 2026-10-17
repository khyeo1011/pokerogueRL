// Checks randomTeam() (bridge/team.ts): seeded, within Classic's budget and party size, only real
// starters, varied, and accepted by the game. Run with scripts/test_bridge.sh team.

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { getRunValueLimit } from "#ui/starter-select-ui-utils";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { startClassicRun } from "../run";
import { CLASSIC_STARTER_POINTS, randomTeam } from "../team";

const SEEDS = Array.from({ length: 5000 }, (_, i) => `train-${i}`);

const cost = (id: SpeciesId) => speciesDataRegistry.getStarterCost(id);
const points = (team: SpeciesId[]) => team.reduce((sum, id) => sum + cost(id), 0);

let phaserGame: Phaser.Game;

beforeAll(() => {
  // Also creates the game's global RNG, Phaser.Math.RND.
  phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
});

describe("randomTeam", () => {
  let teams: SpeciesId[][];

  beforeAll(() => {
    teams = SEEDS.map(randomTeam);
  });

  it("gives the same team for the same seed", () => {
    expect(SEEDS.slice(0, 100).map(randomTeam)).toEqual(teams.slice(0, 100));
    expect(randomTeam(7)).toEqual(randomTeam("7"));
  });

  // Pinned so a change to the draw, or a pokerogue bump that changes the starter list, shows up here:
  // either one changes every seed's team, including held-out ones.
  it("gives a pinned team for a pinned seed", () => {
    expect(randomTeam("train-0")).toEqual([
      SpeciesId.FRIGIBAX,
      SpeciesId.SQUIRTLE,
      SpeciesId.BLITZLE,
      SpeciesId.FINNEON,
    ]);
  });

  it("ignores Math.random and doesn't touch the game's RNG", () => {
    const rndState = Phaser.Math.RND.state();
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random called");
    });
    expect(randomTeam("train-0")).toEqual(teams[0]);
    expect(Phaser.Math.RND.state()).toBe(rndState);

    Phaser.Math.RND.sow(["something else"]);
    expect(randomTeam("train-0")).toEqual(teams[0]);
  });

  it("never exceeds the budget or the party size", () => {
    for (const team of teams) {
      expect(team.length).toBeGreaterThan(0);
      expect(team.length).toBeLessThanOrEqual(PLAYER_PARTY_MAX_SIZE);
      expect(points(team)).toBeLessThanOrEqual(CLASSIC_STARTER_POINTS);
    }
  });

  it("stops only when the party is full or the budget is spent", () => {
    for (const team of teams) {
      expect(team.length === PLAYER_PARTY_MAX_SIZE || points(team) === CLASSIC_STARTER_POINTS).toBe(true);
    }
  });

  it("only picks starters, without duplicates", () => {
    const starters = new Set<SpeciesId>(speciesDataRegistry.getAllStarters());
    for (const team of teams) {
      expect(team.every(id => starters.has(id))).toBe(true);
      expect(new Set(team).size).toBe(team.length);
    }
  });

  it("varies across seeds", () => {
    // Not all distinct: there are few teams around an expensive starter (one cost-10 starter makes one
    // team on its own). 4971 of these 5000 are distinct.
    const distinctTeams = new Set(teams.map(team => team.join(",")));
    expect(distinctTeams.size).toBeGreaterThan(0.95 * teams.length);

    // Every starter cost from 1 to 10 shows up, and most starters appear somewhere.
    const picked = new Set(teams.flat());
    expect(new Set([...picked].map(cost))).toEqual(new Set(Array.from({ length: 10 }, (_, i) => i + 1)));
    expect(picked.size).toBeGreaterThan(0.9 * speciesDataRegistry.getAllStarters().length);
  });
});

describe("a random team in the real game", () => {
  it.each(["train-0", "train-1", "eval-0"])("boots a Classic run with seed %s", async seed => {
    const team = randomTeam(seed);
    const game = new GameManager(phaserGame);
    await startClassicRun(game, seed, ...team);

    expect(game.scene.getPlayerParty().map(p => p.species.speciesId)).toEqual(team);
    expect(getRunValueLimit()).toBe(CLASSIC_STARTER_POINTS);
  });
});
