export type Mode = "interactive" | "automatic";

export interface PortSpec {
  contract: string;
  value?: unknown;
  description?: string;
}

export interface DiscoverySpec {
  tags?: string[];
  kinds?: ("code" | "tool" | "skill")[];
  /** preflight (default): resolved before the run starts. runtime: resolved when the step is reached. */
  resolve?: "preflight" | "runtime";
  /** auto-if-confident (default): automatic runs may proceed without a person. always: always ask. */
  approval?: "auto-if-confident" | "always";
}

export interface Step {
  id: string;
  title?: string;
  type?: "approval";
  message?: string;
  /** Pinned component: plugin#component. The plugin's version is pinned in recipe.plugins. */
  uses?: string;
  /** Plain-language task. Required when no plugin is named; used for discovery. */
  task?: string;
  with?: Record<string, unknown>;
  inputs?: Record<string, PortSpec>;
  outputs?: Record<string, PortSpec>;
  discovery?: DiscoverySpec;
  when?: string;
  foreach?: string;
  as?: string;
  max_items?: number;
  steps?: Step[];
  retry?: { max: number };
  on_failure?: { fallback?: string; action?: "fail" | "skip" };
  only_as_fallback?: boolean;
  approval?: "required";
}

export interface Block {
  id: string;
  title?: string;
  steps: Step[];
}

export interface RecipeInput {
  type: "file" | "string" | "integer" | "number" | "enum";
  description?: string;
  required?: boolean;
  default?: unknown;
  values?: unknown[];
}

export interface Recipe {
  recipe: string;
  version: string;
  title: string;
  description: string;
  industry?: string;
  tags?: string[];
  runtime?: { model?: string; discovery_threshold?: number };
  inputs: Record<string, RecipeInput>;
  plugins: Record<string, { version: string; sha: string }>;
  blocks: Block[];
  outputs: Record<string, string>;
}

export interface LoadedRecipe {
  recipe: Recipe;
  path: string;
  dir: string;
  hash: string;
}

export interface Card {
  id: string;
  kind: "code" | "tool" | "skill";
  entry: string;
  card_status: string;
  summary: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  params?: Record<string, { type?: string; default?: unknown; required?: boolean; description?: string }>;
  [k: string]: unknown;
}

export interface LockEntry {
  step_id: string;
  source: "pinned" | "discovered";
  plugin: string;
  version: string;
  sha: string;
  component: string;
  kind?: string;
  resolved_at?: "preflight" | "runtime";
  confidence?: number;
  reasons?: string;
  candidates?: { component_id: string; score: number; card_status: string; pre_approved: boolean }[];
  approved_by?: string;
  approved_at?: string;
}

export interface Candidate {
  component_id: string;
  plugin: string;
  version: string;
  sha: string;
  component: string;
  kind: string;
  summary: string;
  card_status: string;
  pre_approved: boolean;
  scores: { semantic: number | null; keyword: number | null; fused: number; rerank?: number };
  reason?: string;
}

export interface PendingSelection {
  step_id: string;
  task: string;
  reason: string;
  recommended?: string;
  confidence: number;
  candidates: Candidate[];
}

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_approval";

export interface StepState {
  status: StepStatus;
  order?: number;
  attempts: number;
  component?: string;
  outputs?: Record<string, unknown>;
  output_hashes?: Record<string, string>;
  reproducibility?: "exact" | "snapshot" | "replayable" | "human";
  fallback_from?: string;
  approval?: { decision: "approve" | "reject"; by: string; note?: string; at: string };
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export type RunStatus =
  | "planned" | "needs_selection" | "ready" | "running" | "waiting_approval"
  | "completed" | "failed" | "interrupted";

export interface RunState {
  run_id: string;
  recipe_id: string;
  recipe_version: string;
  recipe_path: string;
  recipe_hash: string;
  mode: Mode;
  model: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  inputs: Record<string, unknown>;
  input_hashes: Record<string, string>;
  steps: Record<string, StepState>;
  pending_selections: PendingSelection[];
  pending_approval: { step_id: string; message: string } | null;
  final_outputs?: Record<string, unknown>;
  evaluation?: unknown;
  error?: string;
  step_counter: number;
}
