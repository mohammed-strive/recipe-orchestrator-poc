// Headless Claude Code sessions, used for agent (skill) steps, candidate reranking and
// capability card generation. Each agent step runs in its own session that loads only the
// plugin it needs (--plugin-dir), with a pinned model.
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { extractJsonObject } from "./util.js";

export interface ClaudeResult {
  text: string;
  raw: unknown;
  cost_usd?: number;
  session_id?: string;
  duration_ms: number;
}

export function runClaude(opts: {
  prompt: string;
  cwd: string;
  model: string;
  pluginDirs?: string[];
  allowedTools?: string[];
  maxTurns?: string;
}): Promise<ClaudeResult> {
  const args = ["-p", "--output-format", "json", "--model", opts.model, "--max-turns", opts.maxTurns ?? config.agentMaxTurns];
  for (const dir of opts.pluginDirs ?? []) args.push("--plugin-dir", dir);
  if (opts.allowedTools?.length) args.push("--permission-mode", "acceptEdits", "--allowedTools", opts.allowedTools.join(","));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude timed out after ${config.agentTimeoutMs} ms`));
    }, config.agentTimeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${config.claudeBin}: ${err.message}. Set CLAUDE_BIN or use AGENT_RUNNER=stub.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(stdout);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(stderr || stdout).slice(-800)}`));
      }
      if (code !== 0 || raw.is_error) return reject(new Error(`claude failed: ${String(raw.result ?? stderr).slice(-800)}`));
      resolve({
        text: String(raw.result ?? ""),
        raw,
        cost_usd: raw.total_cost_usd as number | undefined,
        session_id: raw.session_id as string | undefined,
        duration_ms: Date.now() - started,
      });
    });
    child.stdin.end(opts.prompt);
  });
}

export async function askClaudeForJson(prompt: string, model: string, cwd: string): Promise<{ json: unknown; result: ClaudeResult }> {
  const result = await runClaude({ prompt, cwd, model, maxTurns: "2" });
  return { json: extractJsonObject(result.text), result };
}
