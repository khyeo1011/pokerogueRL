// Policies see only what a player could (issue #10): a policy module may import only the observation and
// decision types, the public static data (bridge/static-data.ts), the damage estimate (bridge/damage.ts,
// itself checked as a policy module) and the game's enums. That keeps the scene,
// Pokémon objects and the game's damage calculation out of reach. A policy written elsewhere (e.g. in a
// test) has the Policy type, so it gets the same two arguments. Run with scripts/test_bridge.sh.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The policy modules, relative to bridge/. */
const POLICY_FILES = ["policy.ts", "damage.ts"];

/** Modules a policy may import from. Their imports reach game code, so only their types are allowed. */
const TYPE_ONLY = new Set(["./observation", "./decisions"]);
/** Modules a policy may import values from: plain data with no game objects in it, or other policy modules. */
const ALLOWED = (specifier: string) =>
  specifier === "./static-data" || specifier === "./damage" || specifier.startsWith("#enums/");
/** Names that reach the game state or damage calculation without an import. */
const FORBIDDEN_NAMES = /\b(globalScene|globalThis|window|getAttackDamage|getBaseDamage|require)\b|\bimport\s*\(/g;

/** Why `source` is not allowed as a policy module; empty if it is. */
function importProblems(source: string): string[] {
  const problems: string[] = [];
  // Static imports and re-exports, and side-effect imports (`import "x"`).
  const statements = /^\s*(import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const [statement, , typeOnly, specifier] of source.matchAll(statements)) {
    if (TYPE_ONLY.has(specifier) ? !typeOnly : !ALLOWED(specifier)) {
      problems.push(statement.trim());
    }
  }
  for (const [name] of source.matchAll(FORBIDDEN_NAMES)) {
    problems.push(name);
  }
  return problems;
}

describe("policy imports", () => {
  it.each(POLICY_FILES)("%s imports no game objects or damage calculation", file => {
    const source = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
    expect(importProblems(source)).toEqual([]);
  });

  it.each([
    'import { globalScene } from "#app/global-scene";',
    'import type { BattleScene } from "#app/battle-scene";',
    'import type { Pokemon } from "#field/pokemon";',
    'import type { GameManager } from "#test/framework/game-manager";',
    'import { allMoves } from "#data/data-lists";',
    'import { getTypeDamageMultiplier } from "#data/type";',
    'import { buildObservation } from "./observation";',
    'import {\n  type Action,\n  commandActions,\n} from "./decisions";',
    'export { Driver } from "./driver";',
    'import "#app/global-scene";',
    "const damage = attacker.getAttackDamage({ source: attacker, move });",
    'const { globalScene } = await import("#app/global-scene");',
  ])("catches a policy with %s", line => {
    expect(importProblems(`import type { Action } from "./decisions";\n${line}\n`)).not.toEqual([]);
  });
});
