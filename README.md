# Recipe Orchestrator — POC

A working prototype of the recipe orchestration design: **Plugin X** (a thin Claude Code plugin) asks the **recipe engine** to run **recipes**. The engine plans each run, pins or discovers plugins through the **capability registry**, records every choice in a **lock file**, runs each step in an isolated plugin set, pauses for people when needed, and keeps a tamper-evident **audit log**.

Everything is mocked except the mechanics: 10 plugins in a local git "marketplace", 2 recipes (finance and retail), and mock FX and inventory systems.

```
                 Claude Code + Plugin X  (/run-recipe, /find-recipe, ...)
                              │ MCP
                              ▼
   ┌──────────────────── recipe engine (host, :7400) ─────────────────────┐
   │ validate → resolve inputs → pin / discover → lock file → materialize │
   │ execute: code · tool · agent · approval · foreach · retry · fallback │
   │ checkpoints · audit hash chain · replay · evals · card generation    │
   └───┬──────────────┬──────────────┬───────────────┬────────────────────┘
       │ python3      │ MCP          │ git clone@SHA │ claude -p --plugin-dir
       ▼              ▼              ▼               ▼
  code steps   capability      git-server       headless Claude Code
               registry :7300  (marketplace)    session per AI step
               │       │        :9418
               ▼       ▼
        postgres    embeddings      mock-data MCP :7310
        +pgvector   (bge-small)     (FX rates, inventory)
        :5433       :7200
   └────────────────── docker compose ──────────────────┘
```

## What this demonstrates

| Design element | Where to see it |
| --- | --- |
| Recipes as blocks of steps, each step optionally naming a plugin | `recipes/*/*/recipe.yaml` |
| Version pinning to exact commit SHAs | `plugins:` in each recipe; engine checks the tag still points at the SHA |
| Dynamic discovery for steps with no plugin | finance `normalise_currency` (before the run), retail `forecast_demand` (during the run) |
| Thin registry with hybrid search | `registry/` — contract filters, then pgvector + Postgres full-text, fused by rank; verified cards rank higher |
| LLM reranking of candidates | `engine/src/resolver.ts` (`RERANK=claude`) |
| Lock file | `.runs/<run>/recipe.lock.json` — pinned and discovered components, alternatives, confidence, who approved |
| Isolated plugin set per run | `.runs/<run>/plugins/<plugin>@<version>` cloned at the locked SHA; nothing installed into your Claude Code |
| AI steps in isolated sessions | each agent step runs `claude -p --plugin-dir <that plugin only> --model <pinned>` |
| Human-in-the-loop fallback (R15) | automatic runs pause with ranked candidates when no pre-approved match is confident enough |
| Approvals | `type: approval` steps with `when:` conditions |
| Branches, loops, fallbacks | `when`, `foreach` + `max_items`, `on_failure.fallback` (LATAM has too little history → naive projection) |
| Reproducibility levels | per step: `exact` (code), `snapshot` (tool data), `replayable` (AI output recorded), `human` |
| Replay | `replay_run` rebuilds a run without AI or data sources and proves outputs are byte-identical |
| Evals and confidence | `recipes/*/*/evals.yaml`, `evaluate_run` |
| Audit | hash-chained `audit.jsonl` per run, mirrored to Postgres (`audit_events`, `runs`) |
| AI-generated capability cards | `legacy-forecast` has no cards; `/generate-cards legacy-forecast` drafts them as `generated` for owner review |
| Governance | `marketplace/policy.json` lists pre-approved components; only verified cards qualify |

## Prerequisites

- Docker with Compose v2
- Node.js 22 or later (the engine uses `--env-file-if-exists`)
- Python 3.10 or later on the host (plugin scripts run on the host)
- git and curl
- Claude Code, signed in (for AI steps, reranking and card generation)

## Quick start

```bash
# 1. Infrastructure: postgres+pgvector, git marketplace, embeddings, mock data, registry
docker compose up -d --build
docker compose logs -f registry      # wait for "initial index: ..." then Ctrl-C

# 2. Recipe engine on the host
cp .env.example .env                 # optional: AGENT_RUNNER=stub runs without AI
cd engine && npm install && npm run build && npm start
# leave it running; open a new terminal for the next steps

# 3. Smoke test (no Claude Code UI needed)
tools/smoke-test.sh

# 4. Use it from Claude Code
claude --plugin-dir ./plugin-x
```

The first `docker compose up --build` downloads the embedding model into the image (about 130 MB).

### In Claude Code

```
/plugin-x:find-recipe I need next quarter's revenue projection by region in USD
/plugin-x:run-recipe quarterly-revenue-projection
/plugin-x:run-recipe weekly-demand-and-stock automatic
/plugin-x:run-status
/plugin-x:replay-run <run id>
/plugin-x:generate-cards legacy-forecast
```

Claude Code may ask you to approve the plugin's MCP servers (`recipe-engine`, `capability-registry`) the first time.

### Suggested demo

1. **Interactive finance run.** `/plugin-x:run-recipe quarterly-revenue-projection` with `samples/actuals.csv`. The currency step has no plugin named, so you are shown two candidates: the verified, pre-approved `fx-rates#convert_currency` and the near-duplicate `fx-converter-lite` (AI-generated card, rounds to whole dollars). Choose one. The run loops over regions, falls back to a naive projection for LATAM, pauses for the variance review (APAC +12.5%), then writes the commentary and report with Claude.
2. **Show the evidence.** Open `.runs/<run>/recipe.lock.json` and `audit.jsonl`, then `/plugin-x:replay-run <run>` and "evaluate this run".
3. **Automatic retail run.** `/plugin-x:run-recipe weekly-demand-and-stock automatic`. The forecast step is resolved during the run. With only one verified candidate it is chosen by policy, and the run pauses only to escalate store S-202 (less than a week of stock).
4. **Catalogue growth.** `/plugin-x:generate-cards legacy-forecast` → review `marketplace/plugins/legacy-forecast/0.9.1/cards.json` → `tools/publish-plugin.sh legacy-forecast 0.9.1`. Run the retail recipe again: there are now two close candidates, so the automatic run stops and asks a person (R15). Choosing the legacy plugin makes the eval score drop, which shows why verified cards and evals matter.

## Repository layout

```
plugin-x/          Claude Code plugin: commands, recipe-runner skill, .mcp.json (engine + registry)
engine/            Recipe engine (TypeScript, MCP over HTTP on :7400, runs on the host)
registry/          Capability registry (TypeScript, MCP over HTTP on :7300, Docker)
infra/             postgres schema, git-server, embeddings service (Python), mock-data MCP server
marketplace/       plugins/<plugin>/<version>/ (seeded into git-server) and policy.json
recipes/           <industry>/<recipe>/recipe.yaml, evals.yaml, samples/, evals/
contracts/         JSON Schemas for the data passed between steps (table/…, data/…, doc/…)
tools/             publish-plugin.sh, print-shas.sh, mcp.sh, smoke-test.sh
.runs/             run directories (created by the engine; git-ignored)
```

## Writing recipes

```yaml
recipe: my-recipe
version: 1.0.0
title: ...
description: ...          # used by find_recipe
runtime: { model: claude-sonnet-5-5, discovery_threshold: 0.6 }
inputs:
  data_csv: { type: file, required: true }
plugins:                  # every plugin a step names, pinned
  fin-ingest: { version: 1.0.0, sha: <commit sha> }     # tools/print-shas.sh
blocks:
  - id: ingest
    steps:
      - id: load                      # pinned step
        uses: fin-ingest#load_actuals
        with: { file: "${inputs.data_csv}" }
      - id: convert                   # open step: discovered and locked
        task: Convert revenue to USD using official FX rates
        inputs:  { actuals: { contract: table/financial-actuals@1, value: "${steps.load.outputs.actuals}" } }
        outputs: { usd: { contract: table/usd-actuals@1 } }
        discovery: { tags: [fx], kinds: [code, tool], resolve: preflight, approval: auto-if-confident }
outputs:
  result: ${steps.convert.outputs.usd}
```

- Expressions are [JSONata](https://jsonata.org) inside `${...}`. In `with` and `inputs` they produce values (file outputs become paths). In `when` and `foreach` they see file contents, for example `$distinct(steps.load.outputs.actuals.region)`.
- Step types: pinned (`uses`), open (`task` + contracts + `discovery`), `type: approval`, `foreach` (with `steps` and `max_items`). Options: `when`, `retry: {max}`, `on_failure: {fallback | action: skip}`, `only_as_fallback`, `approval: required`.
- Discovered components are bound to the step by **data contract**, so any component that consumes and produces the same contracts can be used.

## Plugins and capability cards

Mock plugins follow the Claude Code plugin structure (`.claude-plugin/plugin.json`, `skills/`, `.mcp.json`) and add:

- `cards.json`: one capability card per component (kind `code` | `tool` | `skill`, entry, summary, does / does_not, input and output contracts, params, hosts, tags, examples, limitations, `card_status`).
- `requirements.lock`: pinned Python dependencies for scripts. The engine refuses code components without one.
- Code protocol: `python3 <script> --inputs inputs.json --outdir out/` → `out/outputs.json`.

To publish a new version: add `marketplace/plugins/<plugin>/<new-version>/`, then run `tools/publish-plugin.sh <plugin> <new-version>`. That pushes a tag to the git-server and calls the registry's `/reindex`. Versions are immutable. To reseed everything from `marketplace/plugins`, run `docker compose down -v && docker compose up -d`.

The seed uses fixed authors and dates, so commit SHAs are identical on every machine and the SHAs pinned in the recipes match. If you change a seeded plugin, its SHA changes. The engine will then refuse the old pin; update the recipe from `tools/print-shas.sh`.

## Configuration

See `.env.example`. The settings that matter most:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_RUNNER` | `claude` | `stub` produces placeholder AI output, with no model calls and no cost |
| `RERANK` | `claude` | `none` ranks discovery candidates on retrieval scores only |
| `DEFAULT_MODEL` | `claude-sonnet-5-5` | used when a recipe pins no model, and for reranking and card generation |
| `AUDIT_MODE` | `central` | `local` keeps audit logs in the run directory only |

Without reranking, discovery confidence is computed from retrieval: how strongly the top candidate matched, reduced when the runner-up is close. Two near-identical candidates therefore produce low confidence, and the choice goes to a person.

## POC simplifications

- **Data access (design option B).** Tool steps call MCP servers directly from the engine. The recommended production path (option A) routes them through the host so user credentials stay there. The mock servers need no authentication.
- **Python environments.** Plugins with non-empty `requirements.lock` are rejected rather than given their own virtualenv.
- **Session isolation.** Child sessions load only the step's plugin through `--plugin-dir`, but they still read your user-level Claude Code settings.
- **Execution.** Loop iterations run one after another; there is no caching of completed steps across runs.
- **Hosts.** Only the Claude Code host adapter exists. Cursor and in-house hosts are not implemented.
- **Policy.** `marketplace/policy.json` is a flat file read by the registry, not a governed service.
- **Recipe selection** is semantic + keyword similarity without an LLM.

## Troubleshooting

- `capability registry ... fetch failed`: the registry isn't up yet, or is still indexing. Check `docker compose logs registry`.
- `Could not clone git://localhost:9418/...`: the git-server container isn't running, or port 9418 is taken.
- `... is at <sha> in the marketplace, but the recipe or lock pins <sha>`: a seeded plugin changed. Update the pin from `tools/print-shas.sh`, or reseed.
- `claude failed: ...` in an agent step: check that `claude -p "hi"` works in the same shell, or set `AGENT_RUNNER=stub` to test the pipeline.
- Engine state lives in `.runs/`. Delete it to start fresh. Runs left `running` when the engine stopped become `interrupted`; `start_run` resumes them from their last checkpoint.
