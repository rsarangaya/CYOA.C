# StoryEngine Pro v1.0

StoryEngine Pro is an offline-first browser-based story and text RPG creator. It uses IndexedDB for storage and supports branching blocks, variables, conditional choices, RPG stats/items, day-night progression, daily events, stat-triggered events, storyboard visualization, and save slots.

## Core Features

- **Branching Story Blocks** with named destinations.
- **Variable System** for stats, items, flags, and NPCs.
- **Conditional Logic** for choices and extra text.
- **RPG Support** with stats, equipment, consumables, and passive effects.
- **Day/Night Cycle** with daily scheduled events.
- **Stat-Based Events** that can trigger variable changes or force a block jump.
- **Storyboard / Flowchart View**.
- **Undo/Redo** in the editor.
- **Import/Export** support.
- **Multiple Save Slots** for play mode.

## File Overview

The codebase has been refactored into a modular structure:

- `index.html` - App layout.
- `style.css` - Main styles.
- `globals.js` - Shared app state, UI injections, and Undo/Redo logic.
- `utils.js` - Shared helper functions (markdown, screen switching, coloring).
- `db.js` - IndexedDB schema, auth, dashboard loading, and memory adapter.
- `editor.js` - Story editor UI, block/choice authoring, variables, and events.
- `engine.js` - Play mode, step rendering, inventory logic, and RPG runtime logic.
- `storyboard.js` - Story flow visualization logic.
- `main.js` - App initialization (`window.onload`).

## How to Use

### 1. Create a Story
- Sign in or create an account.
- Open the dashboard.
- Create a new story.
- Give it a title.

### 2. Add Blocks
- Go to the **Blocks** tab in the editor.
- Click **Add Block**.
- Give each block a unique ID.
- Write the narrative text for the active block.

Example:
- `intro`
- `town_gate`
- `forest_path`

### 3. Add Choices
- Open a block.
- Click **Add Choice**.
- Enter choice text and choose the next destination block.

Example:
- Choice text: `Go to the forest`
- Next block: `forest_path`

### 4. Add Variables
Use the **Variables** tab to create:
- **Stats**: HP, Mana, Strength, Reputation
- **Items**: Potion, IronSword
- **Flags**: QuestAccepted, DoorUnlocked
- **NPCs**: Nicholas, GuardCaptain

Example:
- `HP = 20`
- `Potion = 3`
- `QuestAccepted = 0`

### 5. Add Conditions
Choices and extra text can require variables before they appear or activate.

Example:
- Show a choice only if `QuestAccepted >= 1`
- Show text only if `Nicholas == joined`

### 6. Enable Day/Night Cycle
- Open the **Events** tab.
- Toggle **Enable Day/Night Cycle**.
- This creates and uses `TimeOfDay` and `Day`.

Time phases:
1 = Early Morning  
2 = Morning  
3 = Noon  
4 = Afternoon  
5 = Evening  
6 = Night

### 7. Daily Events
When Day/Night is enabled, add scheduled events by day.

Examples:
- On Day 3, set `FestivalStarted = 1`
- On Day 5, jump to block `ambush_scene`

### 8. Stat-Based Events
Stat-based events work even if Day/Night is disabled.

Examples:
- If `HP <= 0`, jump to `game_over`
- If `Reputation >= 10`, set `GuildAccess = 1`
- If `Strength >= 15`, jump to `trial_success`

Optional:
- Enable **Fire Only Once** so the event does not repeat.

### 9. RPG Features
For RPG stories, you can define:
- Stats
- Weapons
- Armor
- Consumables
- Useable items
- Passive flag-based stat modifiers

Examples:
- `IronSword` adds `Atk +5`
- `LeatherArmor` adds `Def +3`
- `Potion` restores `HP +20`

### 10. Storyboard
- Click **Storyboard** in the editor.
- View block flow visually.
- Use it to inspect branching paths without doing a full playthrough.

### 11. Undo/Redo
- Use the Undo/Redo buttons in the editor.
- Keyboard shortcuts:
  - `Ctrl+Z` = Undo
  - `Ctrl+Y` = Redo

### 12. Save / Export / Import
- Save stories to the built-in library.
- Export stories to file.
- Import stories back into the app later.

## Current Limitations

- Full automated battle system is not implemented yet.
- Party/companion system is planned but not complete.
- Asset management for images/audio is intentionally deferred for now.
- The app is text-first and optimized for branching narrative/RPG authoring.

## Recommended Next Steps

1. Add party/companion system.
2. Add full JRPG combat engine.
3. Revisit DOM/reactivity optimization for huge stories.
4. Consider static images.
