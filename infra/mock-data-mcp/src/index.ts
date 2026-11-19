// Mock external data sources exposed as MCP tools over streamable HTTP.
// Stands in for the real FX and inventory systems that plugins reach through MCP.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 7310);

// Month-end rates: 1 unit of currency = rate USD.
const FX: Record<string, Record<string, number>> = {
  "2026-Q1": { USD: 1, EUR: 1.081, GBP: 1.262, INR: 0.01198, JPY: 0.00664 },
  "2026-Q2": { USD: 1, EUR: 1.094, GBP: 1.271, INR: 0.01195, JPY: 0.00651 },
  "2026-Q3": { USD: 1, EUR: 1.102, GBP: 1.284, INR: 0.01191, JPY: 0.00659 },
};

const INVENTORY: Record<string, number> = {
  "S-101": 420, "S-102": 95, "S-103": 610, "S-201": 150, "S-202": 38, "S-203": 300,
};

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mock-data", version: "0.1.0" });

  server.registerTool(
    "get_fx_rates",
    {
      title: "Get FX rates",
      description: "Month-end FX rates to USD for a reporting period such as 2026-Q3.",
      inputSchema: { period: z.string().describe("Reporting period, e.g. 2026-Q3") },
    },
    async ({ period }) => {
      const rates = FX[period];
      if (!rates) throw new Error(`No FX rates for period ${period}. Known: ${Object.keys(FX).join(", ")}`);
      return json({ base: "USD", period, rates });
    },
  );

  server.registerTool(
    "get_inventory_levels",
    {
      title: "Get inventory levels",
      description: "Current on-hand units per store. Omit stores to get every store.",
      inputSchema: { stores: z.array(z.string()).optional() },
    },
    async ({ stores }) => {
      const ids = stores?.length ? stores : Object.keys(INVENTORY);
      return json({
        as_of: "2026-11-16",
        stores: ids.filter((s) => s in INVENTORY).map((s) => ({ store: s, on_hand: INVENTORY[s] })),
      });
    },
  );

  return server;
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`mock-data MCP server on :${PORT}/mcp`));
