// Random starter teams (issue #4). Each run starts with a team drawn as if every starter were unlocked,
// within Classic's 10-point starter budget.
//
// The draw copies the random button on the starter-select screen (processRandomCursorInput in
// src/ui/handlers/starter-select-ui-handler.ts), pressed until it refuses: each press adds a starter
// chosen uniformly among those not yet in the party whose cost fits the points left. It stops at 6
// Pokémon, or when no starter fits (only when all 10 points are spent, since cost-1 starters exist).
//
// Where it differs from the button:
//   - Every starter counts as caught, and costs are base costs: candy cost reductions are save data.
//   - Nothing else is excluded. Classic applies no challenge filters, so the screen offers every species
//     in speciesDataRegistry.getAllStarters().
//   - The RNG is its own Phaser RandomDataGenerator, not Math.random, seeded from "team:" + seed. So it
//     ignores the game's global RNG, and doesn't replay the stream the game sows from the same seed.

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { SpeciesId } from "#enums/species-id";
import Phaser from "phaser";

/** Classic's starter point budget (`getRunValueLimit()` in src/ui/utils/starter-select-ui-utils.ts). */
export const CLASSIC_STARTER_POINTS = 10;

/**
 * Draw a random Classic starter team from `seed`, in party order (lead first).
 * The same seed always gives the same team. Numbers and strings are seeded by their text, so `7` and
 * `"7"` give the same team. For a held-out team set, draw from seeds training never uses, e.g.
 * `"train-<n>"` for training and `"eval-<n>"` for evaluation.
 */
export function randomTeam(seed: string | number): SpeciesId[] {
  const rng = new Phaser.Math.RandomDataGenerator([`team:${seed}`]);
  const team: SpeciesId[] = [];
  let points = CLASSIC_STARTER_POINTS;

  while (team.length < PLAYER_PARTY_MAX_SIZE) {
    const fits = speciesDataRegistry
      .getAllStarters()
      .filter(id => !team.includes(id) && speciesDataRegistry.getStarterCost(id) <= points);
    if (fits.length === 0) {
      break;
    }
    const pick = rng.pick(fits);
    team.push(pick);
    points -= speciesDataRegistry.getStarterCost(pick);
  }
  return team;
}
