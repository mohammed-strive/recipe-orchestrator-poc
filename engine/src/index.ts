// Recipe engine: MCP server over streamable HTTP on the host (default :7400/mcp).
// Runs on the host, not in Docker, so it can start headless Claude Code sessions.
import { mkdirSync } from "node:fs";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { markInterrupted } from "./runs.js";
import { buildServer } from "./server.js";
import { listRuns } from "./store.js";

mkdirSync(config.runsDir, { recursive: true });
markInterrupted(listRuns());

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, agent_runner: config.agentRunner, rerank: config.rerank, audit_mode: config.auditMode }));

app.listen(config.port, "127.0.0.1", () => {
  console.log(`recipe engine on http://localhost:${config.port}/mcp`);
  console.log(`  recipes: ${config.recipesDir}`);
  console.log(`  runs:    ${config.runsDir}`);
  console.log(`  agent runner: ${config.agentRunner}, rerank: ${config.rerank}, audit: ${config.auditMode}`);
});
