// Loading and validating recipes.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { config } from "./config.js";
import { contractExists } from "./contracts.js";
import type { LoadedRecipe, Recipe, Step } from "./types.js";

function findRecipeFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findRecipeFiles(p));
    else if (name === "recipe.yaml") out.push(p);
  }
  return out;
}

export function loadRecipes(): LoadedRecipe[] {
  return findRecipeFiles(config.recipesDir).map((path) => {
    const text = readFileSync(path, "utf8");
    return {
      recipe: YAML.parse(text) as Recipe,
      path,
      dir: dirname(path),
      hash: createHash("sha256").update(text).digest("hex"),
    };
  });
}

export function getRecipe(id: string): LoadedRecipe {
  const [name, version] = id.split("@");
  const matches = loadRecipes().filter((r) => r.recipe.recipe === name && (!version || r.recipe.version === version));
  if (!matches.length) throw new Error(`Unknown recipe ${id}`);
  return matches.sort((a, b) => b.recipe.version.localeCompare(a.recipe.version, undefined, { numeric: true }))[0];
}

/** All steps in execution order (blocks flattened). Fallback-only steps are included; callers skip them. */
export function flatSteps(recipe: Recipe): Step[] {
  return recipe.blocks.flatMap((b) => b.steps);
}

export function findStep(recipe: Recipe, id: string): Step | undefined {
  const walk = (steps: Step[]): Step | undefined => {
    for (const s of steps) {
      if (s.id === id) return s;
      if (s.steps) {
        const inner = walk(s.steps);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  return walk(flatSteps(recipe));
}

export function isOpenStep(step: Step): boolean {
  return !step.uses && step.type !== "approval" && !step.foreach;
}

/** Validation beyond YAML syntax. Returns a list of problems; empty means valid. */
export function validateRecipe(r: Recipe): string[] {
  const problems: string[] = [];
  for (const key of ["recipe", "version", "title", "blocks"] as const) {
    if (!r[key]) problems.push(`missing ${key}`);
  }
  if (!Array.isArray(r.blocks)) return problems;
  const seen = new Set<string>();
  const order: string[] = [];
  const check = (step: Step, scope: string[], innerIds: Set<string>) => {
    if (!step.id || !/^[a-z0-9_]+$/.test(step.id)) problems.push(`step id "${step.id}" must be lowercase letters, digits or _`);
    if (seen.has(step.id)) problems.push(`duplicate step id ${step.id}`);
    seen.add(step.id);
    const refs = JSON.stringify([step.with, step.inputs, step.when, step.foreach]).match(/steps\.([a-z0-9_]+)/g) ?? [];
    for (const ref of refs) {
      const target = ref.slice(6);
      if (!scope.includes(target) && !innerIds.has(target)) {
        problems.push(`step ${step.id} references ${target}, which does not run before it`);
      }
    }
    if (step.uses) {
      const [plugin, component] = step.uses.split("#");
      if (!component) problems.push(`step ${step.id}: uses must look like plugin#component`);
      if (!r.plugins?.[plugin]) problems.push(`step ${step.id}: plugin ${plugin} is not pinned in recipe.plugins`);
    } else if (step.type !== "approval" && !step.foreach) {
      if (!step.task) problems.push(`step ${step.id}: an open step (no plugin named) needs a task description`);
      if (!step.outputs || !Object.keys(step.outputs).length) problems.push(`step ${step.id}: an open step must declare its outputs`);
      for (const [port, spec] of Object.entries({ ...step.inputs, ...step.outputs })) {
        if (!spec?.contract) problems.push(`step ${step.id}: port ${port} needs a contract`);
        else if (!contractExists(spec.contract)) problems.push(`step ${step.id}: unknown contract ${spec.contract}`);
      }
    }
    if (step.foreach) {
      if (!step.steps?.length) problems.push(`step ${step.id}: foreach needs steps`);
      if (!step.max_items) problems.push(`step ${step.id}: foreach needs max_items`);
      const inner = new Set<string>();
      for (const s of step.steps ?? []) {
        check(s, scope, inner);
        if (!s.only_as_fallback) inner.add(s.id);
      }
    }
    if (step.on_failure?.fallback) {
      const fb = findStep(r, step.on_failure.fallback);
      if (!fb) problems.push(`step ${step.id}: fallback ${step.on_failure.fallback} not found`);
      else if (!fb.only_as_fallback) problems.push(`step ${step.id}: fallback ${fb.id} must set only_as_fallback: true`);
    }
  };
  for (const block of r.blocks) {
    for (const step of block.steps ?? []) {
      check(step, order, new Set());
      if (!step.only_as_fallback) order.push(step.id);
    }
  }
  for (const [name, expr] of Object.entries(r.outputs ?? {})) {
    const target = String(expr).match(/steps\.([a-z0-9_]+)/)?.[1];
    if (target && !order.includes(target)) problems.push(`output ${name} references unknown step ${target}`);
  }
  return problems;
}
