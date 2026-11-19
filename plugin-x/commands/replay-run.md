---
description: Replay a completed run and prove its outputs are reproduced exactly
argument-hint: <run id>
---

Call `replay_run` for run $ARGUMENTS. Report whether the replay is identical, the method used for each step (re-executed, snapshot, recorded AI output, loop merge, human decision) and any mismatches. Then call `get_audit_log` and report whether the hash chain is valid.
