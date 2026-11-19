---
description: Approve or reject a recipe step that is waiting for approval
argument-hint: <run id> [approve|reject] [note]
---

For run $ARGUMENTS: call `get_run`, show `pending_approval.message` with the relevant numbers from completed steps, and confirm the decision with the user if it was not given. Then call `approve_step` with the decision and note, and continue following the run as in the recipe-runner skill.
