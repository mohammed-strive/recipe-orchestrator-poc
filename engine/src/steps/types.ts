import type { Card } from "../types.js";

export interface ExecRequest {
  runId: string;
  stepKey: string;
  stepDir: string;
  outDir: string;
  pluginDir: string;
  plugin: string;
  version: string;
  sha: string;
  card: Card;
  /** Port and parameter values for the component. File values are absolute paths. */
  args: Record<string, unknown>;
  task: string;
  model: string;
}

export interface ExecResult {
  /** Output port values. File outputs are absolute paths. */
  outputs: Record<string, unknown>;
  reproducibility: "exact" | "snapshot" | "replayable";
  /** Extra details for the audit log (prompts, tool calls, logs). */
  audit: Record<string, unknown>;
}
