# Mystery encounters: findings

2026-10-17, for issue #8. pokerogue v1.12.1.1 (`bdfbef6`), Node 24.19, Linux.

**Result:** all 31 mystery encounter types complete headless through the driver, with every option of
every type and with the default policy. `bridge/test/mystery-encounters.test.ts` forces each type on the
real game (`startClassicRun`, then the encounter override on the next wave) and plays on until the next
wave starts or the run ends: 31 default-policy rows and 87 one-per-option rows, ~150 ms each. Full runs
with encounters at the game's own rate (`bridge/test/encounter-runs.test.ts`) end in game over with no
hang.

## Decisions

Three new decision kinds (`bridge/decisions.ts`). Battles, reward screens, learning moves and caught or
gifted Pokémon inside an encounter use the existing decisions (`command`, `reward`, `learnMove`,
`partyFull`, ...).

| Decision | Raised on | Legal actions | Answered by | Default policy |
|---|---|---|---|---|
| `mysteryEncounter` | `MYSTERY_ENCOUNTER` in `MysteryEncounterPhase` | `meOption` for every option not greyed out | `MysteryEncounterPhase.handleOptionSelect` | first legal of a per-type preference list (`ENCOUNTER_PREFERENCES`), else first legal |
| `mePokemon` | `PARTY` (`PartyUiMode.SELECT`) during an encounter | `mePokemon` for party slots passing the screen's filter | the party callback with `PartyOption.SELECT` | first |
| `meSubOption` | `OPTION_SELECT` or `CONFIRM` during an encounter | `meSubOption` by index in `labels` | the entry's handler (yes/no handlers for `CONFIRM`) | first |

`mysteryEncounter` carries what the screen shows: `encounterType`, `tier` (the rarity ball), the intro
messages, the description box (`title`, `description`, `query`) and per option the label (and its key),
the tooltip, `disabled` (greyed out) and `special` (drawn in the "requirements met" colour). Texts have the
encounter's tokens filled in (`getEncounterText`, real English locales in the harness) and markup removed.
The test checks the labels against the text objects the menu draws. `followUp: true` marks a later menu of
the same encounter (the Safari Zone's turns); it has no intro.

Legality comes from the UI handler's own `optionsMeetsReqs`: `MysteryEncounterOption.meetsRequirements()`
draws from the RNG (it picks the Pokémon that will act), so calling it again would change the run. An
option is illegal only when it is greyed out (`DISABLED_OR_DEFAULT`/`DISABLED_OR_SPECIAL` with unmet
requirements), as in the UI. Options in `DEFAULT_OR_SPECIAL` mode with unmet requirements stay legal.

`meSubOption` covers three menus:

- the second pick after a Pokémon (`selectPokemonForOption` returning entries: which held item, which
  move, which trade offer, which nature or ability). Its trailing "Cancel" only goes back to the encounter
  menu, so it is not offered (it is, if it is the only entry);
- a menu before the Pokémon (`selectOptionThenPokemon`, only the Bug-Type Superfan's move tutor), where
  "Cancel" means not learning a move and is offered;
- yes/no prompts (only Clowning Around: take the clown's ability?), labels `Yes`, `No`.

Nothing about an option's outcome is in the decision: outcomes are rolled in the option's phase, after
`handleOptionSelect`.

## Fixes that belong here

- **Surviving `GameOverPhase` (`onGameOver`).** The driver reported `gameOver` before starting the phase.
  It now asks the encounter first, as `GameOverPhase.start` does; if `onGameOver()` returns false the phase
  just ends and the run goes on. Only The Expert Pokémon Breeder uses it (losing its one-Pokémon battle
  restores the party). Tested by losing that battle on purpose.
- **Eggs.** Eggs only come from encounters in a fresh save (A Trainer's Test, The Expert Pokémon Breeder).
  `EggLapsePhase` asks "skip hatching?" when two or more hatch at once: the driver answers yes and closes
  the summary screen (`EggSummaryPhase.end()`, what cancel does). One egg hatches with its animation, which
  plays by itself. Hatched Pokémon go to the starter box, not the party, so this is not a decision.
- **Gift Pokémon with a full party.** `catchPokemon` (encounter utils) shows the same Summary / Pokédex /
  Yes / No menu as a capture, so it raises `partyFull`; the species comes from the Pokémon the info box
  last showed.
- **Timers left by an encounter.** The harness's clock runs every timer 1 ms after it is set, in real time.
  The driver doesn't yield to the event loop between phases, so a timer set during an encounter can fire
  waves later. The Strong Stuff's option 1 hides its visuals in a 750 ms timer that reads
  `currentBattle.mysteryEncounter`, which then is gone: an unhandled rejection (vitest reported it; in
  Node it would end the process). The driver now yields a few ms before the `NewBattlePhase` after an
  encounter.
- **Options that lead nowhere.** An option can be legal on the menu and still open a party screen where
  no Pokémon can be picked: The GTS's "Trade an Item" has no requirement, so with no held items in the
  party the player can only cancel. The driver cancels for the agent; the menu shows again without that
  option. Found by a random-policy full run. Any other decision with no legal action makes the driver's
  `next()` throw instead of waiting forever (not seen).

## Encounter inventory

Encounters spawn on wild waves 10–180 of Classic, not on boss waves (x0) or new-biome waves (x1), at
least 3 waves after the previous one; each type has its own wave range, biomes, rarity and
requirements. A type appears at most twice per run; Rogue-tier types, and types with their own limit
(which the constructor turns into 1, even Delibir-dy's 4), at most once. "Pokémon" lists the options
that open the party screen (then a second pick where noted). Option numbers are 1-based; the default is
the policy's preference list.

| Encounter | Tier | Waves | Biomes | Flow | Pokémon | Default |
|---|---|---|---|---|---|---|
| Mysterious Challengers | Great | 10–180 | human | 3 trainer battles of rising difficulty, then rewards | – | 1 |
| Mysterious Chest | Common | 10–180 | any | 1: rewards (70%) or the highest-level Pokémon is KO'd and a Gimmighoul battle (catchable); game over if none is left. 2: leave | – | 2 |
| Dark Deal | Rogue | 30–180 | any | 1: a random party member is taken, 5 Rogue Balls, boss battle (catchable). 2: refuse | – | 2 |
| Fight or Flight | Common | 10–180 | any | 1: boss battle (catchable), item. 2: steal (needs a stealing move), item. 3: leave | – | 2, 3 |
| Slumbering Snorlax | Great | 15–150 | Plains, Grass, Tall Grass | 1: Snorlax battle (catchable). 2: wait, party healed. 3: steal (stealing move) | – | 3, 2 |
| Training Session | Ultra | 10–180 | any | 1–3: the chosen Pokémon leaves the party and the rest fight a boss copy; then IVs (1), nature (2, pick a nature) or ability (3, pick an ability). 4: leave | 1–3 (+ nature/ability for 2, 3) | 4 |
| Department Store Sale | Common | 10–100 | civilization | 4 shops (TMs, vitamins, X items, balls), each a reward screen without rerolls | – | 2 |
| Shady Vitamin Dealer | Common | 10–180 | human | 1/2: pay, chosen Pokémon gets 2 vitamins (cheap one has side effects). 3: leave | 1, 2 | 2, 3 |
| Field Trip | Common | 10–100 | not spawned in this version | 1–3: pick a Pokémon and one of its moves; rewards if the move's category matches | 1–3 (+ move) | 1 |
| Safari Zone | Great | 10–180 | Forest, Swamp, Jungle | 1: pay; 3 Pokémon in turn, a follow-up menu per turn (ball, bait, mud, flee); a catch can raise `partyFull`. 2: leave | – | 2 |
| Lost at Sea | Common | 10–180 | Sea | 1/2: a Pokémon that can learn Surf/Fly helps, EXP. 3: party loses HP | – | 1, 2, 3 |
| Fiery Fallout | Common | 40–180 | Volcano | 1: double battle vs 2 Volcarona (catchable), items. 2: hunker down (burns, damage). 3: fire types help (needs fire type or ability), items | – | 3, 1 |
| The Strong Stuff | Common | 10–180 | Cave | 1: base stats shuffled (two highest −15, rest +10). 2: Shuckle boss battle | – | 1 |
| The Pokémon Salesman | Ultra | 10–180 | human | 1: buy a Pokémon with its hidden ability (`partyFull` if full). 2: refuse | – | 2 |
| An Offer You Can't Refuse | Great | 10–180 | not spawned in this version | 1: give your strongest Pokémon for a Shiny Charm and money. 2: extort (needs a trapping move/ability). 3: leave | – | 2, 3 |
| Delibir-dy | Great | 10–180 | any | 1: give money. 2: give a berry/Reviver Seed. 3: give a held item. Each gives an item | 2, 3 (+ item) | 1, 2, 3 |
| Absolute Avarice | Great | 20–180 | Grass, Tall Grass, Forest | 1: Greedent boss battle. 2: get some berries back. 3: give up the berries, Greedent joins (`partyFull` if full) | – | 2 |
| A Trainer's Test | Rogue | 100–180 | any | 1: trainer battle, very rare egg. 2: party healed, egg | – | 2 |
| Trash to Treasure | Ultra | 100–180 | any | 1: Garbodor boss battle. 2: items, shop prices up | – | 2 |
| Berries Abound | Common | 10–180 | any | 1: battle, berries. 2: race (speed check; battle if lost), berries. 3: leave | – | 2 |
| Clowning Around | Ultra | 80–180 | any | 1: double battle, then yes/no "take its ability?" and a Pokémon. 2: items shuffled. 3: types changed | 1 (after the yes) | 2 |
| Part-Timer | Common | 10–180 | civilization | 1/2: chosen Pokémon works, money by its stats. 3: charming move, money | 1, 2 | 1 |
| Dancing Lessons | Great | 30–180 | Grass, Tall Grass, Beach, Badlands, Meadow, Graveyard, Ruins, Temple, Island | 1: Oricorio battle (catchable), Baton. 2: a Pokémon learns Revelation Dance (`learnMove`). 3: a Pokémon shows a dance move, Oricorio joins | 2, 3 (+ move) | 2 |
| Weird Dream | Rogue | 30–140 | any | 1: party transformed into other species. 2: battle, rewards. 3: leave, party weakened | – | 1 |
| The Winstrate Challenge | Rogue | 100–180 | human | 1: 5 trainer battles in a row (`doContinueEncounter`), item. 2: party healed, Rarer Candy | – | 2 |
| Teleporting Hijinks | Common | 10–180 (waves x2–x4) | any | 1: pay, new biome and a battle. 2: a Steel/Electric Pokémon helps, same plus EXP. 3: battle (catchable) | – | 1 |
| The Bug-Type Superfan | Great | 30–180 | non-extreme | 1: trainer battle, then pick a bug move (or cancel) and a Pokémon (`learnMove`). 2: show bug types (needs one), item. 3: give a bug item | 3 (+ item), 1 after the move | 2, 3, 1 |
| Fun and Games! | Great | 10–180 | civilization | 1: pay; the chosen Pokémon gets 3 turns to hit Wobbuffet (battle commands); reward by result. 2: leave | 1 | 2 |
| Uncommon Breed | Common | 10–180 | any | 1: boss battle (catchable). 2: give 4 berries / 3: charming move, it joins (`partyFull` if full) | – | 3, 2, 1 |
| The GTS | Common | 10–180 | civilization | 1: trade a Pokémon for an offer. 2: wonder trade. 3: trade a held item. 4: leave | 1–3 (+ offer/item for 1, 3) | 4 |
| The Expert Pokémon Breeder | Ultra | 25–180 | human, Space | 1–3: one named Pokémon battles alone; eggs if won; losing doesn't end the run (`onGameOver`) | – | 1 |

Biome groups (`mystery-encounter-biomes.ts`): *human* = 28 biomes where a person could be met (all
non-extreme biomes plus Badlands, Desert, Ice Cave); *civilization* = Town, Plains, Grass, Tall Grass,
Metropolis, Beach, Lake, Meadow, Power Plant, Graveyard, Dojo, Factory, Construction Site, Slum, Island;
*non-extreme* excludes Sea, Seabed, Badlands, Desert, Ice Cave, Volcano, Wasteland, Abyss, Space, End.

## Run results

`bridge/test/encounter-runs.test.ts` with `ENCOUNTER_RUNS=25`: 100 runs on the real game, encounters at
the game's own rate, starters at level 100, 25 seeds per setting:

| Setting | Runs | Game over on wave (min–max, median) | Encounters |
|---|---|---|---|
| Kanto starters, default policy | 25 | 42–114, 80 | 118 |
| Legendaries (Mewtwo, Rayquaza, Groudon), default policy | 25 | 99–140, 114 | 168 |
| Kanto starters, random legal actions | 25 | 16–66, 38 | 45 |
| Legendaries, random legal actions | 23 of 25 | 15–90, 39 | 46 |

383 encounters of 25 types: Training Session 42, Mysterious Challengers 40, Berries Abound 35, Uncommon
Breed 33, Delibir-dy 33, Fight or Flight 29, Mysterious Chest 22, Shady Vitamin Dealer 22, Fun and Games
19, The GTS 14, Department Store Sale 12, Part-Timer 12, The Pokémon Salesman 11, Teleporting Hijinks 11,
Dancing Lessons 9, Slumbering Snorlax 9, Safari Zone 7, Clowning Around 7, Dark Deal 4, Weird Dream 3, The
Strong Stuff 2, Trash to Treasure 2, The Bug-Type Superfan 2, The Expert Pokémon Breeder 2, Fiery Fallout
1. Not met: Field Trip and An Offer You Can't Refuse (don't spawn in this version), Lost at Sea (Sea
only), Absolute Avarice (needs berries), A Trainer's Test and The Winstrate Challenge (wave 100+, Rogue);
all are covered by the forced tests. No run hung at an encounter. The default-policy runs die around wave
110–115 (the evil team boss) or earlier; random-policy runs often die in Training Session, which takes
the chosen Pokémon (often the only strong one) out of the party and makes it the enemy.

Two random runs (seeds `me-run-random-legendary-11` and `-18`) crashed in `CommonBattleAnim.play`
(`targetSprite` undefined): after fleeing a double wild battle, a queued animation of the player's lead
still targets the enemies, whose sprites are gone. This isn't encounter-specific (fleeing a double
battle, reachable without encounters) and is left for the decision-points/watchdog work; `-18`
reproduces it every time on its own.

## Surprises

- **Encounters can be the first wave.** `startClassicRun` restores the real encounter rate before wave 1
  is created, so a run started (with a wave override) on an encounter-eligible wave can open on an
  encounter. The forced tests start on a wave ending in 1, where none can spawn.
- **The menu shows again while an option runs.** `selectPokemonForOption` returns to the mode it came
  from (the encounter menu) before continuing, so the driver ignores the menu of a `MysteryEncounterPhase`
  it already answered.
- **The moveset override only replaces the first moves.** `game.override.moveset([SPLASH])` leaves moves
  2–4 in place; the breeder test sets all four.
- **Forcing an encounter skips its spawn requirements** (`MYSTERY_ENCOUNTER_OVERRIDE`), so the tests give
  each encounter a party, moves and held items that unlock all its options. With the plain party, 14
  options were greyed out (steal/charm/dance/trapping moves, Fly, fire/bug/steel types, held items).
