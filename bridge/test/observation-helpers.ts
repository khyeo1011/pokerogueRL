// Checks shared by the observation tests: is a value plain JSON, and which fields does it contain.
// ALLOWED_PATHS is deliberately written out by hand, separately from the types in bridge/observation.ts:
// adding a field to the observation should mean adding it here too, after checking that a player can see it.

/** Every field path an observation may contain. Array elements are written `[]`. */
export const ALLOWED_PATHS: ReadonlySet<string> = new Set(
  (() => {
    const item = ["id", "args[]", "count", "battlesLeft"];
    const field = ["statStages[]", "tags[]"].map(k => `field.${k}`);
    const own = [
      "speciesId",
      "formIndex",
      "fusionSpeciesId",
      "fusionFormIndex",
      "level",
      "exp",
      "expToNext",
      "gender",
      "shiny",
      "nature",
      "abilityId",
      "passiveAbilityId",
      "teraType",
      "terastallized",
      "types[]",
      "hp",
      "stats[]",
      "ivs[]",
      "status",
      "pokerus",
      "friendship",
      "luck",
      "moves[].moveId",
      "moves[].pp",
      "moves[].maxPp",
      ...item.map(k => `items[].${k}`),
      "fieldIndex",
      ...field,
    ];
    const enemy = [
      "fieldIndex",
      "speciesId",
      "formIndex",
      "fusionSpeciesId",
      "fusionFormIndex",
      "level",
      "gender",
      "shiny",
      "types[]",
      "terastallized",
      "teraType",
      "hp",
      "bossSegments",
      "bossSegmentIndex",
      "status",
      ...field,
      ...item.map(k => `items[].${k}`),
      "revealedMoves[].moveId",
      "revealedMoves[].ppUsed",
      "revealedAbilityId",
      "revealedPassiveId",
    ];
    const option = ["id", "args[]", "tier", "cost", "upgradeCount"];
    const effect = ["type", "turnsLeft", "maxTurns"];
    return [
      "stage.kind",
      "stage.fieldIndex",
      "stage.moveId",
      ...option.map(k => `stage.options[].${k}`),
      ...option.map(k => `stage.shop[].${k}`),
      "stage.rerollCost",
      "stage.item.id",
      "stage.item.args[]",
      "stage.partySlot",
      "stage.speciesId",
      "stage.choices[]",
      "stage.encounterType",
      "stage.tier",
      "stage.options[].disabled",
      "stage.options[].special",
      ...own.map(k => `stage.pokemon.${k}`),
      "run.wave",
      "run.biomeId",
      "run.money",
      "run.pokeballs[]",
      ...item.map(k => `run.modifiers[].${k}`),
      ...own.map(k => `party[].${k}`),
      "battle.battleType",
      "battle.double",
      "battle.turn",
      ...effect.map(k => `battle.weather.${k}`),
      ...effect.map(k => `battle.terrain.${k}`),
      ...["type", "side", "turnsLeft", "maxTurns", "layers"].map(k => `battle.arenaTags[].${k}`),
      "battle.trainer.trainerType",
      "battle.trainer.variant",
      ...["seenSpeciesId", "fainted", "statused"].map(k => `battle.trainer.party[].${k}`),
      ...item.map(k => `battle.enemyModifiers[].${k}`),
      ...enemy.map(k => `battle.enemies[].${k}`),
    ];
  })(),
);

/**
 * The paths of all leaves (primitives and nulls) in `value`, with array indices written `[]`.
 * Throws on anything that is not plain JSON: class instances, functions, undefined, NaN, Infinity.
 */
export function leafPaths(value: unknown, path = "", out = new Set<string>()): Set<string> {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    out.add(path);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: ${value} is not a finite number`);
    }
    out.add(path);
  } else if (Array.isArray(value)) {
    for (const v of value) {
      leafPaths(v, `${path}[]`, out);
    }
  } else if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      leafPaths(v, path ? `${path}.${k}` : k, out);
    }
  } else {
    throw new Error(`${path}: ${typeof value} ${value?.constructor?.name ?? ""} is not plain JSON`);
  }
  return out;
}

/** Leaf paths of `obs` that are not allowed. A null is allowed where an allowed object would be. */
export function disallowedPaths(obs: unknown): string[] {
  const allowed = [...ALLOWED_PATHS];
  return [...leafPaths(obs)].filter(p => !ALLOWED_PATHS.has(p) && !allowed.some(a => a.startsWith(`${p}.`)));
}

/**
 * Paths (with array indices) where `a` and `b` differ, e.g. `battle.enemies[0].hp`. Empty when they are
 * deep-equal. A key present on one side only is reported as a difference at that key.
 */
export function observationDiff(a: unknown, b: unknown, path = ""): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => observationDiff(a[i], b[i], `${path}[${i}]`)).flat();
  }
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap(k =>
      observationDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return Object.is(a, b) ? [] : [path];
}
