---
name: recipe-runner
description: Find, plan, run and audit analysis recipes through the recipe engine. Use when the user wants an analysis, projection or report that a recipe could produce, or asks about a recipe run, its plugins, approvals or audit trail.
---

# Running recipes

Plugin X is a thin front end. All orchestration happens in the **recipe engine** (MCP server `recipe-engine`). Never run analysis steps yourself and never install plugins: the engine runs every step, with the plugin versions recorded in the run's lock file.

## 1. Choose the recipe

- If the user names a recipe, use `describe_recipe` to confirm it exists.
- Otherwise call `find_recipe` with their request. Show the top matches (title, one-line description, score) and **ask the user to confirm** which one to run. Never pick silently.

## 2. Collect inputs

Call `describe_recipe` and list its inputs. Ask only for required inputs the user has not given; mention the defaults for the rest. File inputs may be paths relative to the recipe folder (for example `samples/actuals.csv`) or absolute paths.

Ask whether to run **interactive** (default: the user confirms discovered plugins and approvals as they come) or **automatic** (runs unattended; it pauses only when a person must choose a plugin or approve a step).

## 3. Plan

Call `plan_run` with `recipe_id`, `inputs` and `mode`. Then report:

- the lock: which steps use pinned plugins and which were discovered;
- any `pending_selections`.

### Pending selections (discovered plugins)

For each pending selection, show a short table of candidates: component, kind, card status (verified or generated), pre-approved, scores, and the reason from the reranker if present. State the engine's recommendation and why a person is needed (`reason`). Ask the user to choose, then call `select_component` with their exact choice. Do not choose for them. If they ask for details, use `get_capability_card` on the `capability-registry` server.

## 4. Run and follow progress

- Interactive runs: after selections, call `start_run`. Automatic runs start on their own.
- Poll with `get_run` using `wait_seconds: 20`. Report progress briefly: steps completed, loops, fallbacks used (`fallback_from`), retries.
- If `status` is `needs_selection` during the run (a step resolved at runtime), handle it as in step 3.
- If `status` is `waiting_approval`, show `pending_approval.message` and the relevant numbers from completed steps, then ask the user to approve or reject. Call `approve_step` with their decision and any note. Never approve on the user's behalf.
- If `status` is `failed`, show `error` and the failing step, and suggest the next action.

## 5. Results

When `status` is `completed`:

- Read the file at `report_markdown_path` and show the report.
- List `final_outputs` and where the run is stored (`run_dir`).
- Offer: `evaluate_run` (recipe tests and confidence score), `replay_run` (prove the run reproduces exactly), `get_audit_log` (hash-chained audit trail).

## Notes

- Steps run in isolated headless Claude Code sessions that load only the plugin they need; the user's own installed plugins are never changed.
- Reproducibility levels per step: `exact` (code), `snapshot` (data captured from a tool), `replayable` (AI output recorded), `human` (approval).
