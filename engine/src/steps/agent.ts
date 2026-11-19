// Agent steps: a headless Claude Code session that loads only this step's plugin and runs
// its skill. The output must match the step's data contract. Prompt and response are
// recorded so the step can be replayed without calling the model again.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "../claude.js";
import { config } from "../config.js";
import { contractSchema, isScalar } from "../contracts.js";
import { stubOutput } from "../stub.js";
import { isFileValue } from "../util.js";
import type { ExecRequest, ExecResult } from "./types.js";

function buildPrompt(req: ExecRequest, outFiles: Record<string, string>): string {
  const inputLines = Object.entries(req.args).map(([k, v]) => {
    const contract = req.card.inputs?.[k];
    return isFileValue(v) ? `- ${k}: ${v}${contract ? ` (${contract})` : ""}` : `- ${k}: ${JSON.stringify(v)}`;
  });
  const outLines = Object.entries(outFiles).map(([port, file]) => {
    const contract = req.card.outputs?.[port] as string;
    return `- ${port}: write JSON to ${file}\n  It must validate against this JSON Schema (${contract}):\n  ${JSON.stringify(contractSchema(contract))}`;
  });
  return [
    `You are executing one step of an automated analysis recipe.`,
    ``,
    `Step task: ${req.task}`,
    `Use the "${req.card.entry}" skill from the ${req.plugin} plugin (invoke it with the Skill tool) to do this step.`,
    ``,
    `Inputs (read these files):`,
    ...inputLines,
    ``,
    `Outputs:`,
    ...outLines,
    ``,
    `Rules: use only facts and numbers present in the input files. Do not modify input files.`,
    `Write each output file with the Write tool, then reply with the single word DONE.`,
  ].join("\n");
}

export async function runAgent(req: ExecRequest): Promise<ExecResult> {
  const outFiles: Record<string, string> = {};
  for (const [port, contract] of Object.entries(req.card.outputs ?? {})) {
    if (!isScalar(contract)) outFiles[port] = join(req.outDir, `${port}.json`);
  }
  const prompt = buildPrompt(req, outFiles);
  writeFileSync(join(req.stepDir, "prompt.txt"), prompt);

  if (config.agentRunner === "stub") {
    for (const [port, file] of Object.entries(outFiles)) {
      writeFileSync(file, JSON.stringify(stubOutput(req.card.outputs![port] as string, req.task, req.args), null, 2));
    }
    return { outputs: outFiles, reproducibility: "replayable", audit: { runner: "stub", model: null, prompt } };
  }

  const result = await runClaude({
    prompt,
    cwd: req.stepDir,
    model: req.model,
    pluginDirs: [req.pluginDir],
    allowedTools: ["Read", "Write", "Glob", "Grep", "Skill"],
  });
  writeFileSync(join(req.stepDir, "claude-response.json"), JSON.stringify(result.raw, null, 2));
  for (const [port, file] of Object.entries(outFiles)) {
    if (!existsSync(file)) throw new Error(`agent did not write output ${port} (${file}). Last message: ${result.text.slice(0, 300)}`);
  }
  return {
    outputs: outFiles,
    reproducibility: "replayable",
    audit: {
      runner: "claude", model: req.model, prompt, response: result.text, session_id: result.session_id,
      cost_usd: result.cost_usd, duration_ms: result.duration_ms,
    },
  };
}
