// Builds the search index from the marketplace. The marketplace stays the source of
// truth: this index can be dropped and rebuilt at any time.
import { pool } from "./db.js";
import { embed, embedModelName, toPgVector } from "./embed.js";
import { listPlugins, listVersions, readFileAt, shaFor } from "./git.js";

export interface Card {
  id: string;
  kind: "code" | "tool" | "skill";
  entry: string;
  card_status: "verified" | "generated";
  summary: string;
  does?: string[];
  does_not?: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  params?: Record<string, unknown>;
  hosts?: string[];
  tags?: string[];
  examples?: string[];
  limitations?: string[];
}

const contractsOf = (ports: Record<string, string> | undefined) =>
  Object.values(ports ?? {}).filter((c) => !c.startsWith("scalar:"));

export function searchText(plugin: string, c: Card): string {
  return [
    `${plugin} ${c.id.replace(/_/g, " ")}`,
    c.summary,
    `Does: ${(c.does ?? []).join("; ")}`,
    `Does not: ${(c.does_not ?? []).join("; ")}`,
    `Examples: ${(c.examples ?? []).join("; ")}`,
    `Tags: ${(c.tags ?? []).join(", ")}`,
    `Inputs: ${contractsOf(c.inputs).join(", ")}`,
    `Outputs: ${contractsOf(c.outputs).join(", ")}`,
  ].join("\n");
}

export interface IndexReport {
  plugins: number;
  versions: number;
  components_indexed: number;
  components_skipped_unchanged: number;
  uncarded: string[];
  errors: string[];
}

let running: Promise<IndexReport> | null = null;

/** Index every tagged version of every plugin. Unchanged components are not re-embedded. */
export function reindex(): Promise<IndexReport> {
  if (!running) running = doReindex().finally(() => (running = null));
  return running;
}

async function doReindex(): Promise<IndexReport> {
  const report: IndexReport = {
    plugins: 0, versions: 0, components_indexed: 0, components_skipped_unchanged: 0, uncarded: [], errors: [],
  };
  const model = embedModelName();
  const existing = new Map<string, { sha: string; model: string | null }>();
  for (const row of (await pool.query("select id, sha, embed_model from components")).rows) {
    existing.set(row.id, { sha: row.sha, model: row.embed_model });
  }
  const seen = new Set<string>();

  for (const plugin of listPlugins()) {
    report.plugins++;
    const versions = listVersions(plugin);
    const latest = versions[versions.length - 1];
    for (const version of versions) {
      report.versions++;
      try {
        const sha = shaFor(plugin, version);
        const raw = readFileAt(plugin, version, "cards.json");
        if (!raw) {
          report.uncarded.push(`${plugin}@${version}`);
          await pool.query(
            "insert into uncarded_plugins (plugin, version, sha) values ($1,$2,$3) on conflict (plugin, version) do update set sha = excluded.sha",
            [plugin, version, sha],
          );
          continue;
        }
        await pool.query("delete from uncarded_plugins where plugin = $1 and version = $2", [plugin, version]);
        const cards = (JSON.parse(raw) as { components: Card[] }).components;
        const pending: { id: string; card: Card; text: string }[] = [];
        for (const card of cards) {
          const id = `${plugin}@${version}#${card.id}`;
          seen.add(id);
          const prev = existing.get(id);
          if (prev && prev.sha === sha && prev.model === model) {
            report.components_skipped_unchanged++;
            await pool.query("update components set is_latest = $2 where id = $1", [id, version === latest]);
            continue;
          }
          pending.push({ id, card, text: searchText(plugin, card) });
        }
        const vectors = await embed(pending.map((p) => p.text), "passage");
        for (let i = 0; i < pending.length; i++) {
          const { id, card, text } = pending[i];
          await pool.query(
            `insert into components (id, plugin, version, sha, component, kind, entry, summary, card, card_status,
               tags, hosts, input_contracts, output_contracts, is_latest, search_text, embedding, embed_model, indexed_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::vector,$18, now())
             on conflict (id) do update set sha = excluded.sha, kind = excluded.kind, entry = excluded.entry,
               summary = excluded.summary, card = excluded.card, card_status = excluded.card_status, tags = excluded.tags,
               hosts = excluded.hosts, input_contracts = excluded.input_contracts, output_contracts = excluded.output_contracts,
               is_latest = excluded.is_latest, search_text = excluded.search_text, embedding = excluded.embedding,
               embed_model = excluded.embed_model, indexed_at = now()`,
            [
              id, plugin, version, sha, card.id, card.kind, card.entry, card.summary, JSON.stringify(card),
              card.card_status ?? "generated", card.tags ?? [], card.hosts ?? [], contractsOf(card.inputs),
              contractsOf(card.outputs), version === latest, text, toPgVector(vectors[i]), model,
            ],
          );
          report.components_indexed++;
        }
      } catch (err) {
        report.errors.push(`${plugin}@${version}: ${(err as Error).message}`);
      }
    }
  }
  // Remove components whose plugin version no longer exists in the marketplace.
  const stale = [...existing.keys()].filter((id) => !seen.has(id));
  if (stale.length) await pool.query("delete from components where id = any($1)", [stale]);
  return report;
}
