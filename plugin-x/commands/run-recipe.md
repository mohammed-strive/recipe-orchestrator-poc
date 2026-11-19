---
description: Plan and run a recipe, with discovery, approvals and audit
argument-hint: <recipe id or a description of what you need> [automatic]
---

Use the recipe-runner skill to run a recipe for: $ARGUMENTS

If the arguments name a recipe id, use it; otherwise find one with `find_recipe` and confirm it with the user. If the arguments contain the word "automatic", plan the run in automatic mode; otherwise interactive. Follow the skill's workflow through to the final report.
