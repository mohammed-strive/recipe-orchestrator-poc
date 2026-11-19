---
description: Show the status of a recipe run (or list recent runs)
argument-hint: [run id]
---

If a run id is given ($ARGUMENTS), call `get_run` for it and summarise status, completed steps, pending selections or approvals, and outputs. If the run is waiting for a selection or approval, offer to handle it using the recipe-runner skill.

If no run id is given, call `list_runs` and show the recent runs as a table.
