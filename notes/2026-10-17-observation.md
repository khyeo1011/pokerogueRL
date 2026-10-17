# Observation layer: findings

2026-10-17, for issue #5. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux.

**Result:** `bridge/observation.ts` `buildObservation(scene, tracker, input)` builds the fair-information
observation for every decision stage. `bridge/reveal-tracker.ts` records enemy moves and abilities as the
game reveals them, and `bridge/static-data.ts` exports the public tables the IDs refer to.
`bridge/test/observation.test.ts` checks every stage against a hand-written field allow-list.

## Where the game shows (or decides) what the player sees

| What | Where the game decides it | Used here |
|---|---|---|
| Enemy HP | `BattleInfo.updatePokemonHp` scales the bar to `getHpRatio(true)`. The bar is 48 px wide, 86 px for bosses (`overlay_hp*.json`). No numbers. | HP rounded up to whole bar pixels |
| Enemy held items | Enemy modifier bar: `PokemonHeldItemModifier.isIconVisible()` is true only while the holder is on the field. Non-held enemy modifiers are always shown. | Same filter |
| Enemy moves | `BattleFlyout` lists moves from the `MOVE_USED` event (`scene.eventTarget`) with PP used; it ignores Struggle. Fired when PP is spent, and when Forewarn, Grudge or a PP-reducing move (Spite, Eerie Spell) touches a move. | Same event |
| Enemy ability | Ability popups (`ShowAbilityPhase`) and Frisk/Trace messages call `Pokemon.revealAbility()`. | Hooked |
| Weather, terrain, arena tags | `ArenaFlyout` shows each with turns left / max, and hazard layers. | Read from `arena` |
| Trainer party | `PokeballTray` shows one ball per enemy party member: fainted, statused or healthy. `currentBattle.seenEnemyPartyMemberIds` holds those sent out. | Tray + species of seen ones |
| Own Pokémon | Summary screen: stats, HP, IVs (toggle), nature, ability and passive, tera type, luck, friendship, EXP and EXP to next level, held items, moves with PP, status/Pokérus. | All of it |
| Reward screen | `MODIFIER_SELECT` args: `[player, typeOptions, callback, rerollCost]`. The shop row is computed inside `ModifierSelectUiHandler.show()` from the wave and money (`getPlayerShopModifierTypeOptionsForWave`). | Options from the caller, shop recomputed |

## Gotchas

- **`waveData.abilityRevealed` is not a reveal record.** It resets every wave, and `ShowAbilityPhase`
  sets it after showing a *passive* too (there is a TODO upstream). Using it would leak the main ability
  whenever a passive pops up. The tracker hooks `revealAbility()` and reads the phase's `passive` flag.
- **`MysteryEncounterOption.meetsRequirements()` is not pure.** It draws from the RNG (`randSeedInt`) and
  picks the option's primary Pokémon. The UI calls it once when it shows the options and stores the result
  in `MysteryEncounterUiHandler.optionsMeetsReqs`, so the observation takes that array from the caller
  instead of calling it again.
- **Shop items have no `ModifierType.id`.** `getPlayerShopModifierTypeOptionsForWave` builds them without
  `withIdFromFunc`. Their locale key ends in the key (`modifierType:ModifierType.POTION`), which is used.
- **Illusion:** the battle info shows the disguise's species, form, gender, shininess and types, but the
  real level. The observation does the same.
- `scene.enemyModifiers` is private; `scene.findModifiers(pred, false)` reads it.
