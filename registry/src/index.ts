// Capability registry: a thin MCP server over an index derived from the marketplace.
//   MCP (streamable HTTP):  POST /mcp
//   Reindex (called on publish): POST /reindex
//   Health: GET /health
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { pool, waitForDb } from "./db.js";
import { waitForEmbeddings } from "./embed.js";
import { listVersions, shaFor } from "./git.js";
import { reindex } from "./indexer.js";
import { getCard, search } from "./search.js";

const PORT = Number(process.env.PORT ?? 7300);
const GIT_PUBLIC_URL = process.env.GIT_PUBLIC_URL ?? "git://localhost:9418";
const REINDEX_INTERVAL_SEC = Number(process.env.REINDEX_INTERVAL_SEC ?? 60);

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: "capability-registry", version: "0.1.0" });

  server.registerTool(
    "search_capabilities",
    {
      title: "Search plugin capabilities",
      description:
        "Hybrid (semantic + keyword) search over capability cards of every plugin component in the private marketplace. " +
        "Hard filters apply first. Returns ranked candidates with scores, card status and whether each is pre-approved.",
      inputSchema: {
        query: z.string().describe("What the step needs to do, in plain words"),
        kinds: z.array(z.enum(["code", "tool", "skill"])).optional(),
        tags: z.array(z.string()).optional().describe("Match components having any of these tags"),
        host: z.string().optional().describe("e.g. claude-code"),
        available_contracts: z.array(z.string()).optional().describe("Data contracts the step can provide as inputs"),
        required_outputs: z.array(z.string()).optional().describe("Data contracts the step must produce"),
        plugin: z.string().optional(),
        include_all_versions: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
    },
    async (args) => ok({ candidates: await search(args) }),
  );

  server.registerTool(
    "get_capability_card",
    {
      title: "Get capability card",
      description: "Full capability card for a component: plugin@version#component, or plugin#component for the latest version.",
      inputSchema: { component_id: z.string() },
    },
    async ({ component_id }) => ok(await getCard(component_id)),
  );

  server.registerTool(
    "resolve_component",
    {
      title: "Resolve plugin version",
      description: "Resolve a plugin version (default: latest) to its exact commit SHA and git URL.",
      inputSchema: { plugin: z.string(), version: z.string().optional() },
    },
    async ({ plugin, version }) => {
      const versions = listVersions(plugin);
      const v = version ?? versions[versions.length - 1];
      if (!versions.includes(v)) throw new Error(`${plugin} has no version ${v}. Available: ${versions.join(", ")}`);
      return ok({ plugin, version: v, sha: shaFor(plugin, v), git_url: `${GIT_PUBLIC_URL}/${plugin}.git` });
    },
  );

  server.registerTool(
    "list_plugins",
    {
      title: "List indexed plugins",
      description: "Plugins and versions in the index, with component counts, plus plugin versions that have no capability cards yet.",
      inputSchema: {},
    },
    async () => {
      const { rows } = await pool.query(
        `select plugin, version, sha, is_latest, count(*)::int as components,
                count(*) filter (where card_status = 'verified')::int as verified
         from components group by plugin, version, sha, is_latest order by plugin, version`,
      );
      const uncarded = (await pool.query("select plugin, version, sha from uncarded_plugins order by plugin")).rows;
      return ok({ indexed: rows, uncarded });
    },
  );

  return server;
}

async function main() {
  await waitForDb();
  await waitForEmbeddings();
  const first = await reindex();
  console.log("initial index:", JSON.stringify(first));
  if (REINDEX_INTERVAL_SEC > 0) {
    setInterval(() => void reindex().catch((e) => console.error("reindex failed", e)), REINDEX_INTERVAL_SEC * 1000);
  }

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.post("/reindex", async (_req, res) => {
    try {
      res.json(await reindex());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.listen(PORT, () => console.log(`capability registry on :${PORT}/mcp`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
