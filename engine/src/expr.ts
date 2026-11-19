// Expressions in recipes are JSONata (https://jsonata.org), written as ${...}.
//  - In `with` and `inputs`, they resolve to values; file outputs resolve to file paths.
//  - In `when` and `foreach`, they are evaluated against file contents, so conditions can
//    look inside tables, e.g. $distinct(steps.load.outputs.actuals.region).
import { readFileSync } from "node:fs";
import jsonata from "jsonata";
import { isFileValue } from "./util.js";

export interface ExprContext {
  inputs: Record<string, unknown>;
  steps: Record<string, { outputs: Record<string, unknown>; skipped?: boolean }>;
  item?: unknown;
  index?: number;
}

const WHOLE = /^\$\{([\s\S]+)\}$/;
const EMBEDDED = /\$\{([^}]+)\}/g;

async function evalExpr(expr: string, ctx: unknown): Promise<unknown> {
  return jsonata(expr).evaluate(ctx);
}

export async function interpolate(value: unknown, ctx: ExprContext): Promise<unknown> {
  if (typeof value === "string") {
    const whole = value.match(WHOLE);
    if (whole) return evalExpr(whole[1], ctx);
    if (!value.includes("${")) return value;
    let out = value;
    for (const m of value.matchAll(EMBEDDED)) out = out.replace(m[0], String(await evalExpr(m[1], ctx)));
    return out;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => interpolate(v, ctx)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await interpolate(v, ctx);
    return out;
  }
  return value;
}

/** Same context with every JSON file replaced by its parsed contents. */
export function contentContext(ctx: ExprContext): ExprContext {
  const load = (v: unknown): unknown => {
    if (isFileValue(v) && v.endsWith(".json")) {
      try {
        return JSON.parse(readFileSync(v, "utf8"));
      } catch {
        return v;
      }
    }
    return v;
  };
  const steps: ExprContext["steps"] = {};
  for (const [id, s] of Object.entries(ctx.steps)) {
    steps[id] = { ...s, outputs: Object.fromEntries(Object.entries(s.outputs).map(([k, v]) => [k, load(v)])) };
  }
  return { ...ctx, steps, item: load(ctx.item) };
}

export async function evaluateCondition(expr: string, ctx: ExprContext): Promise<unknown> {
  const inner = expr.match(WHOLE)?.[1] ?? expr;
  return evalExpr(inner, contentContext(ctx));
}
