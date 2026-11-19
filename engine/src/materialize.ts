// Builds a run's isolated plugin set: every plugin is cloned from the marketplace at the
// exact commit in the lock file. Nothing is installed into the user's environment.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { runDir } from "./store.js";
import type { Card } from "./types.js";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function pluginDir(runId: string, plugin: string, version: string): string {
  return join(runDir(runId), "plugins", `${plugin}@${version}`);
}

/** Clones plugin@version into the run, checks the tag still points at the pinned SHA, returns the path. */
export function materializePlugin(runId: string, plugin: string, version: string, sha: string): string {
  const dir = pluginDir(runId, plugin, version);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(join(runDir(runId), "plugins"), { recursive: true });
  const url = `${config.gitBaseUrl}/${plugin}.git`;
  try {
    git(["clone", "--quiet", url, dir]);
  } catch (err) {
    throw new Error(`Could not clone ${url}. Is the git-server container running? ${(err as Error).message}`);
  }
  const tagSha = git(["rev-parse", `v${version}^{commit}`], dir);
  if (tagSha !== sha) {
    throw new Error(
      `${plugin} v${version} is at ${tagSha} in the marketplace, but the recipe or lock pins ${sha}. ` +
        "The plugin was changed after the recipe was written: create a new recipe version (or run tools/print-shas.sh).",
    );
  }
  git(["checkout", "--quiet", sha], dir);
  checkPythonLock(dir, plugin);
  return dir;
}

/** Code components must ship a requirements.lock. Plugins with real dependencies would get a venv here. */
function checkPythonLock(dir: string, plugin: string) {
  const cards = readCards(dir);
  if (!cards.some((c) => c.kind === "code")) return;
  const lock = join(dir, "requirements.lock");
  if (!existsSync(lock)) throw new Error(`${plugin} has code components but no requirements.lock: library versions must be pinned`);
  const deps = readFileSync(lock, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (deps.length) {
    throw new Error(`${plugin} declares Python dependencies; per-plugin virtualenvs are not implemented in this POC`);
  }
}

export function readCards(dir: string): Card[] {
  const p = join(dir, "cards.json");
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")) as { components: Card[] }).components;
}

export function cardFor(dir: string, component: string): Card {
  const card = readCards(dir).find((c) => c.id === component);
  if (!card) throw new Error(`component ${component} has no capability card in ${dir}`);
  return card;
}
