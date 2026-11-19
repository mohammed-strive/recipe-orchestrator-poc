// Thin MCP client helpers: the engine talks to the capability registry and to the MCP
// servers that tool components declare, over streamable HTTP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";
import type { Candidate } from "./types.js";

export async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "recipe-engine", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (res.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  } finally {
    await client.close();
  }
}

async function registry<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  try {
    return JSON.parse(await callTool(config.registryUrl, tool, args)) as T;
  } catch (err) {
    throw new Error(`capability registry (${config.registryUrl}) ${tool}: ${(err as Error).message}`);
  }
}

export const registryClient = {
  search: (args: Record<string, unknown>) => registry<{ candidates: Candidate[] }>("search_capabilities", args),
  card: (componentId: string) =>
    registry<{ component_id: string; plugin: string; version: string; sha: string; card: Record<string, unknown>; card_status: string; pre_approved: boolean }>(
      "get_capability_card", { component_id: componentId }),
  resolve: (plugin: string, version?: string) =>
    registry<{ plugin: string; version: string; sha: string; git_url: string }>("resolve_component", { plugin, version }),
};
