// Read-only access to the marketplace's bare git repositories (the source of truth).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const REPOS_DIR = process.env.GIT_REPOS_DIR ?? "/srv/git";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["--git-dir", join(REPOS_DIR, `${repo}.git`), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function listPlugins(): string[] {
  return readdirSync(REPOS_DIR)
    .filter((d) => d.endsWith(".git"))
    .map((d) => d.slice(0, -4))
    .sort();
}

export function listVersions(plugin: string): string[] {
  const out = git(plugin, ["tag", "--list", "v*"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((t) => t.slice(1))
    .sort(compareSemver);
}

export function shaFor(plugin: string, version: string): string {
  return git(plugin, ["rev-parse", `v${version}^{commit}`]);
}

export function readFileAt(plugin: string, version: string, path: string): string | null {
  try {
    return git(plugin, ["show", `v${version}:${path}`]);
  } catch {
    return null;
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
