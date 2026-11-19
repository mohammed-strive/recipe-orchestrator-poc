// Planning and executing runs.
//   plan:    validate recipe -> resolve inputs -> pin + discover plugins -> lock file -> materialize
//   execute: steps in order with when / foreach / retry / fallback / approvals, checkpointing
//            after every step so a run can pause and resume.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { AuditLog, upsertRunRow } from "./audit.js";
import { config, REPO_ROOT } from "./config.js";
import { isScalar, validateFile } from "./contracts.js";
import { type ExprContext, evaluateCondition, interpolate } from "./expr.js";
import { cardFor, materializePlugin } from "./materialize.js";
import { findStep, flatSteps, getRecipe, isOpenStep, validateRecipe } from "./recipe.js";
import { discover, lockEntryFor } from "./resolver.js";
import { runAgent } from "./steps/agent.js";
import { runCode } from "./steps/code.js";
import { runTool } from "./steps/tool.js";
import type { ExecResult } from "./steps/types.js";
import { type LockFile, loadLock, loadRun, newRunId, runDir, saveLock, saveRun } from "./store.js";
import type { Card, LoadedRecipe, LockEntry, Mode, Recipe, RunState, Step, StepState } from "./types.js";
import { hashValue, isFileValue, now, readJson, sha256 } from "./util.js";

const PAUSED = Symbol("paused");
type Outcome = "done" | typeof PAUSED;

const active = new Map<string, Promise<void>>();

function allSteps(recipe: Recipe): Step[] {
  const out: Step[] = [];
  const walk = (steps: Step[]) => steps.forEach((s) => (out.push(s), s.steps && walk(s.steps)));
  walk(flatSteps(recipe));
  return out;
}

function loadRecipeForRun(state: RunState): LoadedRecipe {
  const lr = getRecipe(`${state.recipe_id}@${state.recipe_version}`);
  if (lr.hash !== state.recipe_hash) {
    throw new Error(`recipe ${state.recipe_id}@${state.recipe_version} changed after this run was planned; plan a new run`);
  }
  return lr;
}

function resolveInputs(lr: LoadedRecipe, provided: Record<string, unknown>, runId: string) {
  const values: Record<string, unknown> = {};
  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(lr.recipe.inputs ?? {})) {
    let v = provided[name] ?? spec.default;
    if (v === undefined || v === null || v === "") {
      if (spec.required) missing.push(name);
      continue;
    }
    if (spec.type === "file") {
      const candidates = isAbsolute(String(v)) ? [String(v)] : [resolve(lr.dir, String(v)), resolve(REPO_ROOT, String(v)), resolve(String(v))];
      const found = candidates.find((p) => existsSync(p));
      if (!found) throw new Error(`input ${name}: file not found (${v})`);
      const dest = join(runDir(runId), "inputs", `${name}-${basename(found)}`);
      mkdirSync(join(runDir(runId), "inputs"), { recursive: true });
      copyFileSync(found, dest);
      v = dest;
    } else if (spec.type === "integer" || spec.type === "number") {
      v = Number(v);
      if (Number.isNaN(v)) throw new Error(`input ${name} must be a number`);
    } else if (spec.type === "enum" && spec.values && !spec.values.includes(v)) {
      throw new Error(`input ${name} must be one of ${spec.values.join(", ")}`);
    }
    values[name] = v;
    hashes[name] = hashValue(v);
  }
  if (missing.length) throw new Error(`missing required inputs: ${missing.join(", ")}`);
  for (const k of Object.keys(provided)) {
    if (!(k in (lr.recipe.inputs ?? {}))) throw new Error(`unknown input ${k}`);
  }
  return { values, hashes };
}

// ------------------------------------------------------------------------------ plan

export async function planRun(recipeId: string, inputs: Record<string, unknown>, mode: Mode, autoStart?: boolean) {
  const lr = getRecipe(recipeId);
  const problems = validateRecipe(lr.recipe);
  if (problems.length) throw new Error(`recipe ${recipeId} is invalid:\n- ${problems.join("\n- ")}`);
  const r = lr.recipe;
  const runId = newRunId(r.recipe);
  mkdirSync(runDir(runId), { recursive: true });
  const model = r.runtime?.model ?? config.defaultModel;
  const { values, hashes } = resolveInputs(lr, inputs, runId);

  const state: RunState = {
    run_id: runId, recipe_id: r.recipe, recipe_version: r.version, recipe_path: lr.path, recipe_hash: lr.hash,
    mode, model, status: "planned", created_at: now(), updated_at: now(), inputs: values, input_hashes: hashes,
    steps: {}, pending_selections: [], pending_approval: null, step_counter: 0,
  };
  saveRun(state);
  const audit = new AuditLog(runId, runDir(runId));
  await audit.append("run_created", {
    recipe: r.recipe, recipe_version: r.version, recipe_hash: lr.hash, mode, model,
    inputs: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isFileValue(v) ? { file: basename(v), sha256: hashes[k] } : v])),
    agent_runner: config.agentRunner, rerank: config.rerank,
  });
  await upsertRunRow(state);

  const lock: LockFile = { recipe: r.recipe, recipe_version: r.version, recipe_hash: lr.hash, model, created_at: now(), updated_at: now(), steps: {} };
  for (const step of allSteps(r)) {
    if (!step.uses) continue;
    const [plugin, component] = step.uses.split("#");
    const pin = r.plugins[plugin];
    lock.steps[step.id] = { step_id: step.id, source: "pinned", plugin, version: pin.version, sha: pin.sha, component };
  }
  const threshold = r.runtime?.discovery_threshold ?? 0.7;
  for (const step of allSteps(r)) {
    if (!isOpenStep(step) || step.discovery?.resolve === "runtime") continue;
    const d = await discover({ step, recipeTitle: r.title, mode, threshold, model, cwd: runDir(runId), stage: "preflight" });
    await audit.append("discovery", {
      stage: "preflight", task: step.task, confidence: d.confidence, auto: d.auto, why: d.why, rerank: d.rerank ?? null,
      candidates: d.candidates.slice(0, 5).map((c) => ({ id: c.component_id, scores: c.scores, card_status: c.card_status, pre_approved: c.pre_approved, reason: c.reason })),
    }, step.id);
    if (d.entry) lock.steps[step.id] = d.entry;
    else if (d.pending) state.pending_selections.push(d.pending);
  }
  saveLock(runId, lock);

  try {
    const plugins = await materializeAll(runId, Object.values(lock.steps));
    await audit.append("plugins_materialized", { plugins });
  } catch (err) {
    state.status = "failed";
    state.error = (err as Error).message;
    saveRun(state);
    await audit.append("run_failed", { error: state.error });
    await upsertRunRow(state);
    throw err;
  }

  state.status = state.pending_selections.length ? "needs_selection" : "ready";
  if (state.pending_selections.length) {
    await audit.append("selection_required", { steps: state.pending_selections.map((p) => ({ step: p.step_id, reason: p.reason })) });
  }
  saveRun(state);
  await upsertRunRow(state);
  if (state.status === "ready" && (autoStart ?? mode === "automatic")) startRun(runId);
  return loadRun(runId);
}

async function materializeAll(runId: string, entries: LockEntry[]) {
  const plugins: Record<string, string> = {};
  for (const e of entries) {
    materializePlugin(runId, e.plugin, e.version, e.sha);
    plugins[`${e.plugin}@${e.version}`] = e.sha;
  }
  return plugins;
}

// ------------------------------------------------------------------------------ selection & approval

export async function selectComponent(runId: string, stepId: string, componentId: string, by = "user") {
  const state = loadRun(runId);
  const pending = state.pending_selections.find((p) => p.step_id === stepId);
  if (!pending) throw new Error(`run ${runId} has no pending selection for step ${stepId}`);
  const chosen = pending.candidates.find((c) => c.component_id === componentId);
  if (!chosen) {
    throw new Error(`${componentId} is not one of the proposed candidates: ${pending.candidates.map((c) => c.component_id).join(", ")}`);
  }
  const lock = loadLock(runId);
  const runtime = Object.keys(state.steps).length > 0;
  lock.steps[stepId] = lockEntryFor(
    stepId, chosen, runtime ? "runtime" : "preflight", pending.confidence, `selected by ${by}`,
    pending.candidates.map((c) => ({ component_id: c.component_id, score: c.scores.rerank ?? c.scores.fused, card_status: c.card_status, pre_approved: c.pre_approved })),
    by,
  );
  saveLock(runId, lock);
  materializePlugin(runId, chosen.plugin, chosen.version, chosen.sha);
  state.pending_selections = state.pending_selections.filter((p) => p.step_id !== stepId);
  const audit = new AuditLog(runId, runDir(runId));
  await audit.append("component_selected", {
    component_id: componentId, sha: chosen.sha, by, recommended: pending.recommended, followed_recommendation: pending.recommended === componentId,
  }, stepId);
  if (!state.pending_selections.length) state.status = "ready";
  saveRun(state);
  await upsertRunRow(state);
  // R15: once the person has chosen, the run continues.
  if (state.status === "ready" && (runtime || state.mode === "automatic")) startRun(runId);
  return loadRun(runId);
}

export async function approveStep(runId: string, stepKey: string, decision: "approve" | "reject", note?: string, by = "user") {
  const state = loadRun(runId);
  if (state.status !== "waiting_approval" || state.pending_approval?.step_id !== stepKey) {
    throw new Error(`run ${runId} is not waiting for approval of ${stepKey}`);
  }
  state.steps[stepKey].approval = { decision, by, note, at: now() };
  state.pending_approval = null;
  const audit = new AuditLog(runId, runDir(runId));
  await audit.append("approval_decided", { decision, by, note: note ?? null }, stepKey);
  if (decision === "reject") {
    state.status = "failed";
    state.steps[stepKey].status = "failed";
    state.error = `step ${stepKey} rejected by ${by}${note ? `: ${note}` : ""}`;
    saveRun(state);
    await audit.append("run_failed", { error: state.error });
    await upsertRunRow(state);
    return state;
  }
  state.status = "ready";
  saveRun(state);
  startRun(runId);
  return loadRun(runId);
}

// ------------------------------------------------------------------------------ execution

export function startRun(runId: string): RunState {
  const state = loadRun(runId);
  if (active.has(runId)) return state;
  if (!["ready", "interrupted"].includes(state.status)) {
    throw new Error(`run ${runId} cannot start from status ${state.status}`);
  }
  state.status = "running";
  saveRun(state);
  const p = execute(runId).finally(() => active.delete(runId));
  active.set(runId, p);
  return state;
}

export function isActive(runId: string) {
  return active.has(runId);
}

class Executor {
  state: RunState;
  lock: LockFile;
  audit: AuditLog;
  lr: LoadedRecipe;

  constructor(public runId: string) {
    this.state = loadRun(runId);
    this.lr = loadRecipeForRun(this.state);
    this.lock = loadLock(runId);
    this.audit = new AuditLog(runId, runDir(runId));
  }

  save() {
    saveRun(this.state);
  }

  stepDir(key: string) {
    return join(runDir(this.runId), "steps", key.replace(/[^a-zA-Z0-9_.-]+/g, "_"));
  }

  async run(): Promise<void> {
    const ctx: ExprContext = { inputs: this.state.inputs, steps: {} };
    const resumed = Object.keys(this.state.steps).length > 0;
    await this.audit.append(resumed ? "run_resumed" : "run_started", { lock_sha256: sha256(readFileSync(join(runDir(this.runId), "recipe.lock.json"))) });
    for (const step of flatSteps(this.lr.recipe)) {
      if (step.only_as_fallback) continue;
      if ((await this.runStep(step, step.id, ctx)) === PAUSED) return;
    }
    await this.finish(ctx);
  }

  async runStep(step: Step, key: string, ctx: ExprContext): Promise<Outcome> {
    const st: StepState = (this.state.steps[key] ??= { status: "pending", attempts: 0 });
    if (st.status === "completed" || st.status === "skipped") {
      ctx.steps[step.id] = { outputs: st.outputs ?? {}, skipped: st.status === "skipped" };
      return "done";
    }
    if (step.when && !(await evaluateCondition(step.when, ctx))) {
      st.status = "skipped";
      st.finished_at = now();
      ctx.steps[step.id] = { outputs: {}, skipped: true };
      await this.audit.append("step_skipped", { when: step.when }, key);
      this.save();
      return "done";
    }

    if (step.type === "approval" || step.approval === "required") {
      if (!st.approval) {
        const message = String((await interpolate(step.message ?? `Approve step ${step.id}?`, ctx)) ?? "").trim();
        st.status = "waiting_approval";
        this.state.pending_approval = { step_id: key, message };
        this.state.status = "waiting_approval";
        await this.audit.append("approval_requested", { message }, key);
        this.save();
        await upsertRunRow(this.state);
        return PAUSED;
      }
      if (step.type === "approval") {
        st.status = "completed";
        st.reproducibility = "human";
        st.order = ++this.state.step_counter;
        st.finished_at = now();
        st.outputs = { decision: st.approval.decision };
        ctx.steps[step.id] = { outputs: st.outputs };
        this.save();
        return "done";
      }
    }

    if (step.foreach) return this.runLoop(step, key, ctx);
    return this.runComponentStep(step, key, ctx);
  }

  async runLoop(step: Step, key: string, ctx: ExprContext): Promise<Outcome> {
    const st = this.state.steps[key];
    const items = await evaluateCondition(step.foreach!, ctx);
    const list = Array.isArray(items) ? items : items === undefined ? [] : [items];
    if (list.length > (step.max_items ?? 0)) throw new Error(`foreach ${step.id}: ${list.length} items exceeds max_items ${step.max_items}`);
    st.status = "running";
    const inner = (step.steps ?? []).filter((s) => !s.only_as_fallback);
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < list.length; i++) {
      const iterCtx: ExprContext = { ...ctx, steps: { ...ctx.steps }, item: list[i], index: i };
      for (const s of inner) {
        if ((await this.runStep(s, `${key}[${i}].${s.id}`, iterCtx)) === PAUSED) return PAUSED;
      }
      results.push(iterCtx.steps[inner[inner.length - 1].id]?.outputs ?? {});
    }
    // Merge: table outputs are concatenated into one file, scalars become a list.
    const outDir = join(this.stepDir(key), "out");
    mkdirSync(outDir, { recursive: true });
    const merged: Record<string, unknown> = {};
    for (const port of new Set(results.flatMap((r) => Object.keys(r)))) {
      const values = results.map((r) => r[port]);
      if (values.every((v) => isFileValue(v) && Array.isArray(readJson(v)))) {
        const file = join(outDir, `${port}.json`);
        writeFileSync(file, JSON.stringify(values.flatMap((v) => readJson<unknown[]>(v as string)), null, 2));
        merged[port] = file;
      } else merged[port] = values;
    }
    st.status = "completed";
    st.outputs = merged;
    st.output_hashes = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, hashValue(v)]));
    st.order = ++this.state.step_counter;
    st.finished_at = now();
    ctx.steps[step.id] = { outputs: merged };
    await this.audit.append("loop_completed", { items: list, output_hashes: st.output_hashes }, key);
    this.save();
    return "done";
  }

  async resolveAtRuntime(step: Step, key: string, ctx: ExprContext): Promise<LockEntry | null> {
    const available = Object.entries(ctx.steps)
      .filter(([, s]) => !s.skipped)
      .map(([id, s]) => `${id}: ${Object.keys(s.outputs).join(", ")}`)
      .join("; ");
    const r = this.lr.recipe;
    const d = await discover({
      step, recipeTitle: r.title, mode: this.state.mode, threshold: r.runtime?.discovery_threshold ?? 0.7,
      model: this.state.model, cwd: runDir(this.runId), stage: "runtime", context: `Completed steps so far: ${available}`,
    });
    await this.audit.append("discovery", {
      stage: "runtime", task: step.task, confidence: d.confidence, auto: d.auto, why: d.why,
      candidates: d.candidates.slice(0, 5).map((c) => ({ id: c.component_id, scores: c.scores, card_status: c.card_status, pre_approved: c.pre_approved, reason: c.reason })),
    }, key);
    if (d.entry) {
      this.lock = loadLock(this.runId);
      this.lock.steps[step.id] = d.entry;
      saveLock(this.runId, this.lock);
      return d.entry;
    }
    this.state.pending_selections.push(d.pending!);
    this.state.status = "needs_selection";
    await this.audit.append("selection_required", { steps: [{ step: step.id, reason: d.why }] }, key);
    this.save();
    await upsertRunRow(this.state);
    return null;
  }

  async runComponentStep(step: Step, key: string, ctx: ExprContext): Promise<Outcome> {
    const st = this.state.steps[key];
    this.lock = loadLock(this.runId);
    let entry = this.lock.steps[step.id];
    if (!entry) {
      const resolved = await this.resolveAtRuntime(step, key, ctx);
      if (!resolved) return PAUSED;
      entry = resolved;
    }
    st.status = "running";
    st.started_at ??= now();
    this.save();

    const max = (step.retry?.max ?? 0) + 1;
    let lastError = "";
    while (st.attempts < max) {
      st.attempts++;
      try {
        const res = await this.execute(step, key, entry, ctx, "out");
        return this.complete(step, key, entry, res, ctx);
      } catch (err) {
        lastError = (err as Error).message;
        await this.audit.append("step_attempt_failed", { attempt: st.attempts, of: max, error: lastError }, key);
        this.save();
      }
    }

    const fbId = step.on_failure?.fallback;
    if (fbId) {
      const fb = findStep(this.lr.recipe, fbId)!;
      const fbEntry = this.lock.steps[fb.id];
      await this.audit.append("fallback_started", { fallback: fb.id, component: `${fbEntry.plugin}@${fbEntry.version}#${fbEntry.component}`, after_error: lastError }, key);
      const res = await this.execute(fb, key, fbEntry, ctx, "fallback");
      st.fallback_from = `${entry.plugin}@${entry.version}#${entry.component}`;
      return this.complete(step, key, fbEntry, res, ctx);
    }
    if (step.on_failure?.action === "skip") {
      st.status = "skipped";
      st.error = lastError;
      ctx.steps[step.id] = { outputs: {}, skipped: true };
      await this.audit.append("step_skipped", { after_error: lastError }, key);
      this.save();
      return "done";
    }
    st.status = "failed";
    st.error = lastError;
    this.save();
    throw new Error(`step ${key} failed: ${lastError}`);
  }

  async execute(step: Step, key: string, entry: LockEntry, ctx: ExprContext, outName: string): Promise<{ res: ExecResult; card: Card; args: Record<string, unknown> }> {
    const pluginDir = materializePlugin(this.runId, entry.plugin, entry.version, entry.sha);
    const card = cardFor(pluginDir, entry.component);
    const args = await this.bindArgs(step, entry, card, ctx);
    const stepDir = this.stepDir(key);
    const outDir = join(stepDir, outName);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const req = {
      runId: this.runId, stepKey: key, stepDir, outDir, pluginDir, plugin: entry.plugin, version: entry.version, sha: entry.sha,
      card, args, task: step.task ?? step.title ?? card.summary, model: this.state.model,
    };
    await this.audit.append("step_started", { component: `${entry.plugin}@${entry.version}#${entry.component}`, sha: entry.sha, kind: card.kind, source: entry.source }, key);
    const res = card.kind === "code" ? await runCode(req) : card.kind === "tool" ? await runTool(req) : await runAgent(req);
    for (const [port, contract] of Object.entries(card.outputs ?? {})) {
      if (isScalar(contract)) continue;
      const problem = validateFile(contract, String(res.outputs[port]));
      if (problem) throw new Error(`output ${port} does not match its contract: ${problem}`);
    }
    return { res, card, args };
  }

  /** Maps recipe values onto the component's ports. Discovered components are bound by data contract. */
  async bindArgs(step: Step, entry: LockEntry, card: Card, ctx: ExprContext): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {};
    const withVals = ((await interpolate(step.with ?? {}, ctx)) ?? {}) as Record<string, unknown>;
    if (entry.source === "pinned") Object.assign(args, withVals);
    else {
      for (const [port, contract] of Object.entries(card.inputs ?? {})) {
        const spec = Object.values(step.inputs ?? {}).find((s) => s.contract === contract);
        if (!spec) throw new Error(`step ${step.id} provides no input with contract ${contract} for ${card.id}.${port}`);
        args[port] = await interpolate(spec.value, ctx);
      }
      for (const name of Object.keys(card.params ?? {})) if (name in withVals) args[name] = withVals[name];
    }
    for (const [name, p] of Object.entries(card.params ?? {})) {
      if (args[name] === undefined && p.default !== undefined) args[name] = p.default;
      if (args[name] === undefined && p.required) throw new Error(`${card.id} needs parameter ${name}`);
    }
    for (const [port, contract] of Object.entries(card.inputs ?? {})) {
      if (args[port] === undefined) throw new Error(`${card.id} needs input ${port} (${contract})`);
      const problem = validateFile(contract, String(args[port]));
      if (problem) throw new Error(`input ${port} does not match its contract: ${problem}`);
    }
    return args;
  }

  async complete(step: Step, key: string, entry: LockEntry, r: { res: ExecResult; card: Card; args: Record<string, unknown> }, ctx: ExprContext): Promise<Outcome> {
    const st = this.state.steps[key];
    let outputs = r.res.outputs;
    if (entry.source === "discovered" && step.outputs) {
      // Map component ports onto the step's declared ports by contract.
      const mapped: Record<string, unknown> = {};
      for (const [port, spec] of Object.entries(step.outputs)) {
        const src = Object.entries(r.card.outputs ?? {}).find(([, c]) => c === spec.contract)?.[0] ?? port;
        if (!(src in outputs)) throw new Error(`component output does not provide ${spec.contract} for ${port}`);
        mapped[port] = outputs[src];
      }
      outputs = mapped;
    }
    st.status = "completed";
    st.outputs = outputs;
    st.output_hashes = Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, hashValue(v)]));
    st.reproducibility = r.res.reproducibility;
    st.component = `${entry.plugin}@${entry.version}#${entry.component}`;
    st.order = ++this.state.step_counter;
    st.finished_at = now();
    ctx.steps[step.id] = { outputs };
    await this.audit.append("step_completed", {
      component: st.component, sha: entry.sha, source: entry.source, reproducibility: st.reproducibility,
      input_hashes: Object.fromEntries(Object.entries(r.args).map(([k, v]) => [k, hashValue(v)])),
      output_hashes: st.output_hashes, fallback_from: st.fallback_from ?? null, attempts: st.attempts, details: r.res.audit,
    }, key);
    this.save();
    return "done";
  }

  async finish(ctx: ExprContext) {
    const outDir = join(runDir(this.runId), "outputs");
    mkdirSync(outDir, { recursive: true });
    const final: Record<string, unknown> = {};
    for (const [name, expr] of Object.entries(this.lr.recipe.outputs ?? {})) {
      const v = await interpolate(expr, ctx);
      if (isFileValue(v)) {
        const dest = join(outDir, `${name}.json`);
        copyFileSync(v, dest);
        const doc = readJson<{ markdown?: string }>(dest);
        if (doc && typeof doc.markdown === "string") writeFileSync(join(outDir, `${name}.md`), doc.markdown);
        final[name] = dest;
      } else final[name] = v;
    }
    this.state.final_outputs = final;
    this.state.status = "completed";
    this.save();
    const manifest = {
      run_id: this.runId, recipe: this.state.recipe_id, recipe_version: this.state.recipe_version, recipe_hash: this.state.recipe_hash,
      mode: this.state.mode, model: this.state.model, agent_runner: config.agentRunner,
      lock_sha256: sha256(readFileSync(join(runDir(this.runId), "recipe.lock.json"))),
      plugins: Object.fromEntries(Object.values(loadLock(this.runId).steps).map((e) => [`${e.plugin}@${e.version}`, e.sha])),
      inputs: this.state.input_hashes,
      outputs: Object.fromEntries(Object.entries(final).map(([k, v]) => [k, { file: isFileValue(v) ? basename(v) : null, sha256: hashValue(v) }])),
      steps: Object.entries(this.state.steps)
        .filter(([, s]) => s.status === "completed" && s.component)
        .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
        .map(([k, s]) => ({ step: k, component: s.component, reproducibility: s.reproducibility, fallback_from: s.fallback_from ?? null, output_hashes: s.output_hashes })),
      completed_at: now(),
    };
    await this.audit.append("run_completed", { outputs: manifest.outputs });
    const withHead = { ...manifest, audit_head: this.audit.headHash };
    writeFileSync(join(runDir(this.runId), "manifest.json"), JSON.stringify(withHead, null, 2));
    await upsertRunRow(this.state, withHead);
  }
}

async function execute(runId: string) {
  let ex: Executor | null = null;
  try {
    ex = new Executor(runId);
    await ex.run();
  } catch (err) {
    const state = ex?.state ?? loadRun(runId);
    state.status = "failed";
    state.error = (err as Error).message;
    saveRun(state);
    const audit = ex?.audit ?? new AuditLog(runId, runDir(runId));
    await audit.append("run_failed", { error: state.error });
    await upsertRunRow(state);
  }
}

/** Runs left "running" when the engine stopped are marked interrupted; start_run resumes them. */
export function markInterrupted(states: RunState[]) {
  for (const s of states) {
    if (s.status === "running") {
      s.status = "interrupted";
      saveRun(s);
    }
  }
}
