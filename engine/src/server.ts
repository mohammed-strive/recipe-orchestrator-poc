// The engine's MCP tools, used by Plugin X (or any MCP client).
import { existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAudit, verifyChain } from "./audit.js";
import { generateCards } from "./cards.js";
import { config } from "./config.js";
import { evaluateRun } from "./evals.js";
import { flatSteps, getRecipe, isOpenStep, loadRecipes, validateRecipe } from "./recipe.js";
import { findRecipes } from "./recipeSearch.js";
import { replayRun } from "./replay.js";
import { approveStep, isActive, planRun, selectComponent, startRun } from "./runs.js";
import { listRuns, loadLock, loadRun, lockPath, runDir } from "./store.js";
import type { RunState, Step } from "./types.js";
import { sleep } from "./util.js";

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function summarize(state: RunState) {
  const lock = existsSync(lockPath(state.run_id)) ? loadLock(state.run_id) : null;
  const report = state.final_outputs
    ? Object.values(state.final_outputs).map((v) => String(v).replace(/\.json$/, ".md")).find((p) => existsSync(p))
    : undefined;
  return {
    run_id: state.run_id,
    recipe: `${state.recipe_id}@${state.recipe_version}`,
    mode: state.mode,
    model: state.model,
    status: state.status,
    executing: isActive(state.run_id),
    error: state.error ?? null,
    pending_selections: state.pending_selections.map((p) => ({
      step_id: p.step_id, task: p.task, reason: p.reason, recommended: p.recommended, confidence: p.confidence,
      candidates: p.candidates.map((c) => ({
        component_id: c.component_id, kind: c.kind, summary: c.summary, card_status: c.card_status,
        pre_approved: c.pre_approved, scores: c.scores, reason: c.reason ?? null,
      })),
    })),
    pending_approval: state.pending_approval,
    steps: Object.entries(state.steps).map(([key, s]) => ({
      step: key, status: s.status, component: s.component ?? null, reproducibility: s.reproducibility ?? null,
      attempts: s.attempts, fallback_from: s.fallback_from ?? null, error: s.error ?? null,
    })),
    lock: lock
      ? Object.values(lock.steps).map((e) => ({
          step: e.step_id, source: e.source, component: `${e.plugin}@${e.version}#${e.component}`, sha: e.sha.slice(0, 12),
          approved_by: e.approved_by ?? null, confidence: e.confidence ?? null,
        }))
      : [],
    final_outputs: state.final_outputs ?? null,
    report_markdown_path: report ?? null,
    evaluation: state.evaluation ?? null,
    run_dir: runDir(state.run_id),
  };
}

function describeStep(s: Step): unknown {
  if (s.foreach) return { id: s.id, kind: "loop", foreach: s.foreach, steps: (s.steps ?? []).map(describeStep) };
  if (s.type === "approval") return { id: s.id, kind: "approval", when: s.when ?? null };
  return {
    id: s.id, kind: s.uses ? "pinned" : "discover", uses: s.uses ?? null, task: s.task ?? null,
    discovery: isOpenStep(s) ? s.discovery ?? {} : undefined, when: s.when ?? null,
    approval: s.approval ?? null, fallback: s.on_failure?.fallback ?? null, only_as_fallback: s.only_as_fallback ?? false,
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "recipe-engine", version: "0.1.0" });

  server.registerTool("list_recipes", { title: "List recipes", description: "All recipes in the recipes repository.", inputSchema: {} },
    async () => ok(loadRecipes().map(({ recipe: r }) => ({
      recipe_id: `${r.recipe}@${r.version}`, title: r.title, industry: r.industry ?? null, description: r.description,
      valid: validateRecipe(r).length === 0,
    }))));

  server.registerTool("find_recipe", {
    title: "Find a recipe",
    description: "Propose the recipes that best match a request (semantic + keyword). The user confirms the choice.",
    inputSchema: { request: z.string(), limit: z.number().int().optional() },
  }, async ({ request, limit }) => ok({ candidates: await findRecipes(request, limit ?? 3) }));

  server.registerTool("describe_recipe", {
    title: "Describe a recipe",
    description: "Inputs, blocks and steps of a recipe, showing which steps pin a plugin and which use discovery.",
    inputSchema: { recipe_id: z.string().describe("name or name@version") },
  }, async ({ recipe_id }) => {
    const lr = getRecipe(recipe_id);
    const r = lr.recipe;
    return ok({
      recipe_id: `${r.recipe}@${r.version}`, title: r.title, description: r.description, inputs: r.inputs,
      pinned_plugins: r.plugins, runtime: r.runtime ?? {},
      blocks: r.blocks.map((b) => ({ id: b.id, title: b.title, steps: b.steps.map(describeStep) })),
      outputs: r.outputs, problems: validateRecipe(r), path: lr.path,
      open_steps: flatSteps(r).flatMap((s) => [s, ...(s.steps ?? [])]).filter(isOpenStep).map((s) => s.id),
    });
  });

  server.registerTool("plan_run", {
    title: "Plan a run",
    description:
      "Validate the recipe, resolve inputs, pin plugins, discover plugins for open steps, write the lock file and prepare the isolated plugin set. " +
      "Interactive runs return discovered plugins for the user to confirm (select_component). Automatic runs start immediately unless a selection is needed.",
    inputSchema: {
      recipe_id: z.string(),
      inputs: z.record(z.any()).optional(),
      mode: z.enum(["interactive", "automatic"]).optional(),
      auto_start: z.boolean().optional(),
    },
  }, async ({ recipe_id, inputs, mode, auto_start }) => ok(summarize(await planRun(recipe_id, inputs ?? {}, mode ?? "interactive", auto_start))));

  server.registerTool("select_component", {
    title: "Select a discovered plugin",
    description: "Choose one of the proposed candidates for a step that needs a selection. Recorded in the lock file and audit log.",
    inputSchema: { run_id: z.string(), step_id: z.string(), component_id: z.string(), selected_by: z.string().optional() },
  }, async ({ run_id, step_id, component_id, selected_by }) => ok(summarize(await selectComponent(run_id, step_id, component_id, selected_by ?? "user"))));

  server.registerTool("start_run", {
    title: "Start or resume a run",
    description: "Start a planned run, or resume an interrupted one from its last checkpoint. Returns immediately; use get_run to follow progress.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => ok(summarize(startRun(run_id))));

  server.registerTool("get_run", {
    title: "Get run status",
    description: "Status, steps, pending selections or approvals, lock summary and outputs. wait_seconds (max 25) waits for the status to change.",
    inputSchema: { run_id: z.string(), wait_seconds: z.number().optional() },
  }, async ({ run_id, wait_seconds }) => {
    const start = loadRun(run_id);
    const deadline = Date.now() + Math.min(wait_seconds ?? 0, 25) * 1000;
    let state = start;
    while (Date.now() < deadline && state.status === start.status && state.step_counter === start.step_counter) {
      await sleep(500);
      state = loadRun(run_id);
    }
    return ok(summarize(state));
  });

  server.registerTool("approve_step", {
    title: "Approve or reject a step",
    description: "Decide on a step waiting for approval. Approving resumes the run; rejecting stops it.",
    inputSchema: { run_id: z.string(), step_id: z.string(), decision: z.enum(["approve", "reject"]), note: z.string().optional(), decided_by: z.string().optional() },
  }, async ({ run_id, step_id, decision, note, decided_by }) => ok(summarize(await approveStep(run_id, step_id, decision, note, decided_by ?? "user"))));

  server.registerTool("list_runs", { title: "List runs", description: "Recent runs, newest first.", inputSchema: { limit: z.number().int().optional() } },
    async ({ limit }) => ok(listRuns().slice(0, limit ?? 20).map((s) => ({
      run_id: s.run_id, recipe: `${s.recipe_id}@${s.recipe_version}`, mode: s.mode, status: s.status, created_at: s.created_at,
    }))));

  server.registerTool("replay_run", {
    title: "Replay a run",
    description: "Rebuild a completed run from its records without calling any AI model or data source, and check the outputs are identical.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => ok(await replayRun(run_id)));

  server.registerTool("evaluate_run", {
    title: "Evaluate a run",
    description: "Run the recipe's evals against a run's outputs and return a confidence score.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => ok(await evaluateRun(run_id)));

  server.registerTool("get_audit_log", {
    title: "Get audit log",
    description: "A run's audit events (most recent last) and a check that the hash chain is intact.",
    inputSchema: { run_id: z.string(), last: z.number().int().optional() },
  }, async ({ run_id, last }) => {
    const dir = runDir(run_id);
    const events = readAudit(dir);
    return ok({
      chain: verifyChain(dir),
      audit_mode: config.auditMode,
      events: events.slice(-(last ?? 50)).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, step: e.step_id, data: e.data })),
      manifest: existsSync(`${dir}/manifest.json`) ? JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) : null,
    });
  });

  server.registerTool("generate_capability_cards", {
    title: "Generate capability cards",
    description: "Use AI to draft capability cards for a plugin version that has none. Writes a new version (card_status: generated) to marketplace/plugins for owner review and publishing.",
    inputSchema: { plugin: z.string(), version: z.string().optional() },
  }, async ({ plugin, version }) => ok(await generateCards(plugin, version)));

  return server;
}
