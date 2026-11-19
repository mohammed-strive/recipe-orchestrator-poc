// Recipe tests (evals): checks kept next to each recipe in evals.yaml. They give a run a
// confidence score, and validate "close enough" re-runs of AI steps.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import jsonata from "jsonata";
import YAML from "yaml";
import { AuditLog } from "./audit.js";
import { getRecipe } from "./recipe.js";
import { loadRun, runDir, saveRun } from "./store.js";
import { hashFile, isFileValue, readJson } from "./util.js";

interface Check {
  id: string;
  step: string;
  port: string;
  kind: "golden" | "contains" | "expression" | "schema";
  golden?: string;
  when_inputs?: Record<string, string>;
  tolerance?: { relative?: number };
  field?: string;
  values?: string[];
  expr?: string;
}

function closeEnough(a: unknown, b: unknown, rel: number, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") {
    const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return Math.abs(a - b) / scale <= rel ? null : `${path}: ${a} vs expected ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: ${a.length} items vs expected ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = closeEnough(a[i], b[i], rel, `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(b as object)) {
      const d = closeEnough((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], rel, `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs expected ${JSON.stringify(b)}`;
}

export async function evaluateRun(runId: string) {
  const state = loadRun(runId);
  const lr = getRecipe(`${state.recipe_id}@${state.recipe_version}`);
  const file = join(lr.dir, "evals.yaml");
  if (!existsSync(file)) return { available: false, message: "this recipe has no evals.yaml" };
  const spec = YAML.parse(readFileSync(file, "utf8")) as { threshold?: number; checks: Check[] };
  const threshold = spec.threshold ?? 0.8;
  const results: { id: string; applicable: boolean; passed: boolean; detail?: string }[] = [];

  for (const c of spec.checks) {
    const value = state.steps[c.step]?.outputs?.[c.port];
    if (value === undefined) {
      results.push({ id: c.id, applicable: false, passed: false, detail: `step ${c.step} produced no ${c.port}` });
      continue;
    }
    const data = isFileValue(value) ? readJson(value) : value;
    if (c.when_inputs) {
      const matches = Object.entries(c.when_inputs).every(([name, path]) => {
        const p = resolve(lr.dir, path);
        return existsSync(p) && state.input_hashes[name] === hashFile(p);
      });
      if (!matches) {
        results.push({ id: c.id, applicable: false, passed: false, detail: "run used different inputs" });
        continue;
      }
    }
    let detail: string | null = null;
    if (c.kind === "golden") {
      detail = closeEnough(data, readJson(resolve(lr.dir, c.golden!)), c.tolerance?.relative ?? 0);
    } else if (c.kind === "contains") {
      const text = String(c.field ? (data as Record<string, unknown>)[c.field] : JSON.stringify(data)).toLowerCase();
      const missing = (c.values ?? []).filter((v) => !text.includes(v.toLowerCase()));
      detail = missing.length ? `missing: ${missing.join(", ")}` : null;
    } else if (c.kind === "expression") {
      detail = (await jsonata(c.expr!).evaluate(data)) ? null : `expression false: ${c.expr}`;
    }
    results.push({ id: c.id, applicable: true, passed: detail === null, detail: detail ?? undefined });
  }

  const applicable = results.filter((r) => r.applicable);
  const score = applicable.length ? applicable.filter((r) => r.passed).length / applicable.length : 0;
  const evaluation = { available: true, threshold, confidence: Number(score.toFixed(3)), passed: score >= threshold, checks: results };
  state.evaluation = evaluation;
  saveRun(state);
  await new AuditLog(runId, runDir(runId)).append("eval_completed", { confidence: evaluation.confidence, passed: evaluation.passed, failed: results.filter((r) => r.applicable && !r.passed).map((r) => r.id) });
  return evaluation;
}
