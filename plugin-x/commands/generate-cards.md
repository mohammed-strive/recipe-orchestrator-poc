---
description: Draft capability cards with AI for a plugin that has none
argument-hint: <plugin> [version]
---

1. Call `list_plugins` on the capability-registry server and confirm that the plugin in "$ARGUMENTS" is listed under `uncarded`.
2. Call `generate_capability_cards` on the recipe-engine server for it.
3. Show the generated cards in a readable table (component, kind, summary, inputs, outputs, limitations) and where they were written.
4. Remind the user that the cards are marked `generated`: the plugin owner must review them and set `card_status` to `verified` before the component can be pre-approved. Show the publish command from `next_steps`.
