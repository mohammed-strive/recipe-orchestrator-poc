import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const config = {
  port: Number(env("ENGINE_PORT", "7400")),
  recipesDir: resolve(REPO_ROOT, env("RECIPES_DIR", "recipes")),
  contractsDir: resolve(REPO_ROOT, env("CONTRACTS_DIR", "contracts")),
  runsDir: resolve(REPO_ROOT, env("RUNS_DIR", ".runs")),
  marketplaceSrc: resolve(REPO_ROOT, env("MARKETPLACE_SRC", "marketplace/plugins")),
  registryUrl: env("REGISTRY_URL", "http://localhost:7300/mcp"),
  gitBaseUrl: env("GIT_BASE_URL", "git://localhost:9418"),
  embeddingsUrl: env("EMBEDDINGS_URL", "http://localhost:7200"),
  databaseUrl: env("DATABASE_URL", "postgres://poc:poc@localhost:5433/orchestrator"),
  /** central: write audit events to Postgres as well as the run directory. local: run directory only. */
  auditMode: env("AUDIT_MODE", "central") as "central" | "local",
  /** claude: real headless Claude Code sessions. stub: deterministic placeholder output (no AI, no cost). */
  agentRunner: env("AGENT_RUNNER", "claude") as "claude" | "stub",
  claudeBin: env("CLAUDE_BIN", "claude"),
  defaultModel: env("DEFAULT_MODEL", "claude-sonnet-5-5"),
  agentMaxTurns: env("AGENT_MAX_TURNS", "25"),
  agentTimeoutMs: Number(env("AGENT_TIMEOUT_MS", "600000")),
  /** claude: an LLM reranks discovery candidates. none: retrieval scores only. */
  rerank: env("RERANK", process.env.AGENT_RUNNER === "stub" ? "none" : "claude") as "claude" | "none",
  host: env("HOST_NAME", "claude-code"),
  python: env("PYTHON_BIN", "python3"),
  codeTimeoutMs: Number(env("CODE_TIMEOUT_MS", "120000")),
};
