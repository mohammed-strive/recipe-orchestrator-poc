-- Schema for the capability registry index and the central audit store.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per plugin component per published version (tag).
CREATE TABLE IF NOT EXISTS components (
  id            text PRIMARY KEY,               -- <plugin>@<version>#<component>
  plugin        text        NOT NULL,
  version       text        NOT NULL,
  sha           text        NOT NULL,
  component     text        NOT NULL,
  kind          text        NOT NULL,           -- code | tool | skill
  entry         text        NOT NULL,           -- script path, MCP tool name or skill name
  summary       text        NOT NULL,
  card          jsonb       NOT NULL,
  card_status   text        NOT NULL,           -- verified | generated
  tags          text[]      NOT NULL DEFAULT '{}',
  hosts         text[]      NOT NULL DEFAULT '{}',
  input_contracts  text[]   NOT NULL DEFAULT '{}',
  output_contracts text[]   NOT NULL DEFAULT '{}',
  is_latest     boolean     NOT NULL DEFAULT false,
  search_text   text        NOT NULL,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
  embedding     vector(384),
  embed_model   text,
  indexed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS components_tsv_idx ON components USING gin (tsv);
CREATE INDEX IF NOT EXISTS components_plugin_idx ON components (plugin, version);

-- Plugins published without capability cards (candidates for AI card generation).
CREATE TABLE IF NOT EXISTS uncarded_plugins (
  plugin   text NOT NULL,
  version  text NOT NULL,
  sha      text NOT NULL,
  PRIMARY KEY (plugin, version)
);

-- Central audit store: one row per audit event, hash-chained per run.
CREATE TABLE IF NOT EXISTS audit_events (
  run_id     text        NOT NULL,
  seq        integer     NOT NULL,
  ts         timestamptz NOT NULL,
  type       text        NOT NULL,
  step_id    text,
  data       jsonb       NOT NULL,
  prev_hash  text        NOT NULL,
  hash       text        NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id          text PRIMARY KEY,
  recipe          text NOT NULL,
  recipe_version  text NOT NULL,
  mode            text NOT NULL,
  status          text NOT NULL,
  manifest        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
