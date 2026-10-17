// Smoke test: play a Classic run headlessly through pokerogue's vitest harness, with no species or
// move overrides, until WAVES waves are cleared, the party wipes, or the turn budget runs out (the fixed
// policy below can stalemate, e.g. at -6 accuracy against a foe that never attacks).
// Run with scripts/test_bridge.sh.

import { BattleType } from "#enums/battle-type";
import { SpeciesId } from "#enums/species-id";
import { GameOverPhase } from "#phases/game-over-phase";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";

const WAVES = 10;
const TURN_BUDGET = 150;

/** Each active player Pokémon uses its highest-power usable move on the first active enemy. */
function selectStrongestMoves(game: GameManager): void {
  const double = game.scene.currentBattle.double;
  const target = game.scene
    .getEnemyField()
    .find(e => e.isActive(true))!
    .getBattlerIndex();
  game.scene.getPlayerField().forEach((pokemon, i) => {
    if (!pokemon.isActive(true)) {
      return;
    }
    const usable = pokemon.getMoveset().filter(m => m.isUsable(pokemon)[0]);
    const move = usable.reduce((a, b) => (b.getMove().power > a.getMove().power ? b : a));
    game.move.select(move.moveId, i as 0 | 1, double ? target : undefined);
  });
}

/** Queue party-menu picks for fainted player Pokémon on the field, if anyone is left on the bench. */
function sendInReplacements(game: GameManager, log: string[]): void {
  const party = game.scene.getPlayerParty();
  const slots = game.scene.currentBattle.double ? 2 : 1;
  const bench = party.map((_, i) => i).filter(i => i >= slots && !party[i].isFainted());
  for (const pokemon of party.slice(0, slots)) {
    if (pokemon.isFainted() && bench.length > 0) {
      const slot = bench.shift()!;
      log.push(`  ${pokemon.name} fainted, sent in ${party[slot].name}`);
      game.doSelectPartyPokemon(slot);
    }
  }
}

/** Play the current wave from its first CommandPhase until every enemy has fainted or maxTurns is reached. */
async function playWave(game: GameManager, log: string[], maxTurns: number): Promise<{ won: boolean; turns: number }> {
  const battle = game.scene.currentBattle;
  const enemies = battle.enemyParty.map(p => `${p.name} L${p.level}`).join(", ");
  for (let turn = 1; turn <= maxTurns; turn++) {
    selectStrongestMoves(game);
    await game.toEndOfTurn();
    if (game.isVictory()) {
      log.push(`wave ${battle.waveIndex} (${BattleType[battle.battleType]}${battle.double ? " double" : ""}): beat ${enemies}`);
      return { won: true, turns: turn };
    }
    sendInReplacements(game, log);
    // Not toEndOfTurn: trainers send in their next Pokémon after TurnEndPhase.
    await game.toNextTurn();
  }
  return { won: false, turns: maxTurns };
}

describe("Classic run (headless)", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  it(`plays up to ${WAVES} waves`, { timeout: 120_000 }, async () => {
    // After a wipe the harness would wait for TurnEndPhase until it times out. Throwing here makes
    // phaseInterceptor.to() reject immediately (vi.waitUntil stops on the first throw).
    let gameOver = false;
    vi.spyOn(GameOverPhase.prototype, "start").mockImplementation(() => {
      gameOver = true;
      throw new Error("game over");
    });

    const t0 = performance.now();
    const game = new GameManager(phaserGame);
    await game.classicMode.startBattle(SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
    // generateStarters() skips the starter-select UI, which is what normally fills player movesets.
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.generateAndPopulateMoveset();
    }
    const tBattle = performance.now();

    const log: string[] = [];
    let turns = 0;
    let wavesCleared = 0;
    let outOfTurns = false;
    try {
      while (wavesCleared < WAVES) {
        const wave = await playWave(game, log, TURN_BUDGET - turns);
        turns += wave.turns;
        if (!wave.won) {
          outOfTurns = true;
          log.push(`turn budget ran out on wave ${game.scene.currentBattle.waveIndex}`);
          break;
        }
        wavesCleared++;
        await game.toNextWave();
      }
    } catch (e) {
      if (!gameOver) {
        throw e;
      }
      log.push(`game over on wave ${game.scene.currentBattle.waveIndex}`);
    }

    // Counted from the phase log so the turn that ended in a game over is included.
    const turnsPlayed = game.phaseInterceptor.phaseLog.filter(p => p === "TurnEndPhase").length;
    const bootSeconds = (tBattle - t0) / 1000;
    const playSeconds = (performance.now() - tBattle) / 1000;
    console.info(
      `\n=== Classic run ===\n${log.join("\n")}\n`
        + `${wavesCleared} waves cleared; boot to first turn ${bootSeconds.toFixed(1)}s; `
        + `${turnsPlayed} turns in ${playSeconds.toFixed(1)}s (${(turnsPlayed / playSeconds).toFixed(1)} turns/s)\n`,
    );
    expect(wavesCleared).toBeGreaterThan(0);
    if (!gameOver && !outOfTurns) {
      expect(game.scene.currentBattle.waveIndex).toBe(WAVES + 1);
    }
  });
});
