// Smoke test: play a Classic run headlessly through pokerogue's vitest harness, with no species or
// move overrides, until WAVES waves are cleared, the party wipes, or the turn budget runs out (the
// policy can stalemate, e.g. at -6 accuracy against a foe that never attacks). Moves, targets and
// replacements are the default policy's choices from the observation (bridge/policy.ts), applied with
// the harness's helpers; rewards are skipped. Run with scripts/test_bridge.sh.

import { BattleType } from "#enums/battle-type";
import type { BattlerIndex } from "#enums/battler-index";
import { SpeciesId } from "#enums/species-id";
import { GameOverPhase } from "#phases/game-over-phase";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ActionOf, commandActions, moveTargets, switchActions } from "../decisions";
import { buildObservation } from "../observation";
import { defaultPolicy } from "../policy";
import { RevealTracker } from "../reveal-tracker";

const WAVES = 10;
const TURN_BUDGET = 150;

/** Each active player Pokémon uses the default policy's move (only moves are offered) and target. */
function selectMoves(game: GameManager, tracker: RevealTracker): void {
  const scene = game.scene;
  scene.getPlayerField().forEach((pokemon, fieldIndex) => {
    if (!pokemon.isActive(true)) {
      return;
    }
    const moves = commandActions(fieldIndex).filter(a => a.kind === "move" && !a.tera);
    const obs = buildObservation(scene, tracker, { kind: "command", fieldIndex });
    const { slot } = defaultPolicy(obs, moves) as ActionOf<"move">;
    const moveId = pokemon.getMoveset()[slot].moveId;
    // As in the driver, a target is only chosen for a single-target move in a double battle.
    let target: BattlerIndex | undefined;
    const { targets, multiple } = moveTargets(fieldIndex, moveId);
    if (scene.currentBattle.double && !multiple && targets.length > 0) {
      const legal = targets.map(t => ({ kind: "target" as const, target: t }));
      const targetObs = buildObservation(scene, tracker, { kind: "target", fieldIndex, moveId });
      target = (defaultPolicy(targetObs, legal) as ActionOf<"target">).target;
    }
    game.move.select(moveId, fieldIndex as 0 | 1, target);
  });
}

/** Queue the default policy's party-menu picks for fainted player Pokémon on the field, if any can go in. */
function sendInReplacements(game: GameManager, tracker: RevealTracker, log: string[]): void {
  const scene = game.scene;
  const party = scene.getPlayerParty();
  const picked: number[] = [];
  party.slice(0, scene.currentBattle.getBattlerCount()).forEach((pokemon, fieldIndex) => {
    const legal = switchActions().filter(a => !picked.includes(a.partySlot));
    if (pokemon.isFainted() && legal.length > 0) {
      const obs = buildObservation(scene, tracker, { kind: "switch", fieldIndex });
      const slot = (defaultPolicy(obs, legal) as ActionOf<"switch">).partySlot;
      picked.push(slot);
      log.push(`  ${pokemon.name} fainted, sent in ${party[slot].name}`);
      game.doSelectPartyPokemon(slot);
    }
  });
}

/** Play the current wave from its first CommandPhase until every enemy has fainted or maxTurns is reached. */
async function playWave(
  game: GameManager,
  tracker: RevealTracker,
  log: string[],
  maxTurns: number,
): Promise<{ won: boolean; turns: number }> {
  const battle = game.scene.currentBattle;
  const enemies = battle.enemyParty.map(p => `${p.name} L${p.level}`).join(", ");
  for (let turn = 1; turn <= maxTurns; turn++) {
    selectMoves(game, tracker);
    await game.toEndOfTurn();
    if (game.isVictory()) {
      log.push(`wave ${battle.waveIndex} (${BattleType[battle.battleType]}${battle.double ? " double" : ""}): beat ${enemies}`);
      return { won: true, turns: turn };
    }
    sendInReplacements(game, tracker, log);
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
    // Created after the first summon, so it misses reveals during it (the first wave's entry abilities).
    const tracker = new RevealTracker(game.scene);
    const tBattle = performance.now();

    const log: string[] = [];
    let turns = 0;
    let wavesCleared = 0;
    let outOfTurns = false;
    try {
      while (wavesCleared < WAVES) {
        const wave = await playWave(game, tracker, log, TURN_BUDGET - turns);
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
    tracker.dispose();

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
