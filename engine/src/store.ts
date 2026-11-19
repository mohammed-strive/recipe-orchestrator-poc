// Run state on disk: .runs/<run_id>/state.json plus lock, plugins, inputs, steps and audit log.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { LockEntry, RunState } from "./types.js";
import { now } from "./util.js";

export const runDir = (runId: string) => join(config.runsDir, runId);
export const lockPath = (runId: string) => join(runDir(runId), "recipe.lock.json");

export interface LockFile {
  recipe: string;
  recipe_version: string;
  recipe_hash: string;
  model: string;
  created_at: string;
  updated_at: string;
  steps: Record<string, LockEntry>;
}

export function newRunId(recipeId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${recipeId}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function writeAtomic(path: string, data: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
}

export function saveRun(state: RunState) {
  mkdirSync(runDir(state.run_id), { recursive: true });
  state.updated_at = now();
  writeAtomic(join(runDir(state.run_id), "state.json"), state);
}

export function loadRun(runId: string): RunState {
  const p = join(runDir(runId), "state.json");
  if (!existsSync(p)) throw new Error(`Unknown run ${runId}`);
  return JSON.parse(readFileSync(p, "utf8")) as RunState;
}

export function listRuns(): RunState[] {
  if (!existsSync(config.runsDir)) return [];
  return readdirSync(config.runsDir)
    .filter((d) => !d.startsWith("_") && existsSync(join(config.runsDir, d, "state.json")))
    .map((d) => loadRun(d))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function loadLock(runId: string): LockFile {
  return JSON.parse(readFileSync(lockPath(runId), "utf8")) as LockFile;
}

export function saveLock(runId: string, lock: LockFile) {
  lock.updated_at = now();
  writeAtomic(lockPath(runId), lock);
}
