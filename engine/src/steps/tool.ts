// Tool steps: call an MCP tool declared by the plugin with fixed arguments. The result is
// saved as a snapshot, so later steps and replays never call the source again.
// POC note: the engine calls the MCP server directly (design option B). The recommended
// production path (option A) routes the call through the host so user credentials stay there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isScalar } from "../contracts.js";
import { callTool } from "../mcpClient.js";
import { now, sha256 } from "../util.js";
import type { ExecRequest, ExecResult } from "./types.js";

export async function runTool(req: ExecRequest): Promise<ExecResult> {
  const [server, tool] = req.card.entry.split("/");
  const mcpFile = join(req.pluginDir, ".mcp.json");
  if (!existsSync(mcpFile)) throw new Error(`${req.plugin} declares tool ${req.card.entry} but has no .mcp.json`);
  const servers = (JSON.parse(readFileSync(mcpFile, "utf8")) as { mcpServers: Record<string, { url?: string }> }).mcpServers;
  const url = servers[server]?.url;
  if (!url) throw new Error(`${req.plugin}/.mcp.json has no HTTP server named ${server}`);

  const args = Object.fromEntries(Object.entries(req.args).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const text = await callTool(url, tool, args);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`tool ${tool} did not return JSON`);
  }
  const ports = Object.entries(req.card.outputs ?? {}).filter(([, c]) => !isScalar(c));
  if (ports.length !== 1) throw new Error(`tool component ${req.card.id} must declare exactly one data output`);
  const [port] = ports[0];
  const file = join(req.outDir, `${port}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  const snapshot = { server: url, tool, arguments: args, fetched_at: now(), sha256: sha256(readFileSync(file)) };
  writeFileSync(join(req.stepDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  return { outputs: { [port]: file }, reproducibility: "snapshot", audit: { snapshot } };
}
