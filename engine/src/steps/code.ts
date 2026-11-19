// Code steps: run a plugin's Python script directly, with no AI involved.
// Protocol: python3 <entry> --inputs inputs.json --outdir out/  ->  out/outputs.json
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { config } from "../config.js";
import { isScalar } from "../contracts.js";
import type { ExecRequest, ExecResult } from "./types.js";

export function runPython(script: string, inputsFile: string, outDir: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [script, "--inputs", inputsFile, "--outdir", outDir], {
      cwd,
      env: { PATH: process.env.PATH ?? "", PYTHONHASHSEED: "0", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), config.codeTimeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function runCode(req: ExecRequest): Promise<ExecResult> {
  const script = join(req.pluginDir, req.card.entry);
  if (!existsSync(script)) throw new Error(`script ${req.card.entry} not found in ${req.plugin}@${req.version}`);
  const inputsFile = join(req.stepDir, "inputs.json");
  writeFileSync(inputsFile, JSON.stringify(req.args, null, 2));
  const res = await runPython(script, inputsFile, req.outDir, req.stepDir);
  writeFileSync(join(req.stepDir, "stdout.log"), res.stdout);
  writeFileSync(join(req.stepDir, "stderr.log"), res.stderr);
  if (res.code !== 0) throw new Error(`${req.card.entry} exited ${res.code}: ${res.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return { outputs: readOutputs(req), reproducibility: "exact", audit: { script: req.card.entry, inputs_file: inputsFile } };
}

/** Reads out/outputs.json and turns file outputs into absolute paths. */
export function readOutputs(req: Pick<ExecRequest, "outDir" | "card">): Record<string, unknown> {
  const file = join(req.outDir, "outputs.json");
  if (!existsSync(file)) throw new Error("component did not write outputs.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const outputs: Record<string, unknown> = {};
  for (const [port, contract] of Object.entries(req.card.outputs ?? {})) {
    if (!(port in raw)) throw new Error(`component did not produce output ${port}`);
    const v = raw[port];
    outputs[port] = !isScalar(contract) && typeof v === "string" && !isAbsolute(v) ? join(req.outDir, v) : v;
  }
  return outputs;
}
