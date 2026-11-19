// Tamper-evident audit log: append-only JSONL per run, each event hash-chained to the
// previous one. Mirrored to the central Postgres store unless AUDIT_MODE=local.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { config } from "./config.js";
import { canonical, now, sha256 } from "./util.js";

export interface AuditEvent {
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  step_id: string | null;
  data: unknown;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
let pool: pg.Pool | null = null;
const db = () => (pool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 4 }));

export function auditPath(runDir: string) {
  return join(runDir, "audit.jsonl");
}

export function readAudit(runDir: string): AuditEvent[] {
  const p = auditPath(runDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEvent);
}

function eventHash(e: Omit<AuditEvent, "hash">): string {
  return sha256(e.prev_hash + canonical({ run_id: e.run_id, seq: e.seq, ts: e.ts, type: e.type, step_id: e.step_id, data: e.data }));
}

export class AuditLog {
  private seq: number;
  private head: string;
  private syncFailed = false;

  constructor(private runId: string, private runDir: string) {
    const events = readAudit(runDir);
    this.seq = events.length ? events[events.length - 1].seq : 0;
    this.head = events.length ? events[events.length - 1].hash : GENESIS;
  }

  get headHash() {
    return this.head;
  }

  async append(type: string, data: unknown, stepId: string | null = null): Promise<AuditEvent> {
    const base = { run_id: this.runId, seq: this.seq + 1, ts: now(), type, step_id: stepId, data, prev_hash: this.head };
    const event: AuditEvent = { ...base, hash: eventHash(base) };
    appendFileSync(auditPath(this.runDir), JSON.stringify(event) + "\n");
    this.seq = event.seq;
    this.head = event.hash;
    if (config.auditMode === "central") await this.sync();
    return event;
  }

  /** Pushes any events the central store does not have yet. Failures are retried on the next append. */
  async sync(): Promise<void> {
    try {
      const { rows } = await db().query("select coalesce(max(seq), 0)::int as max from audit_events where run_id = $1", [this.runId]);
      const missing = readAudit(this.runDir).filter((e) => e.seq > rows[0].max);
      for (const e of missing) {
        await db().query(
          "insert into audit_events (run_id, seq, ts, type, step_id, data, prev_hash, hash) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing",
          [e.run_id, e.seq, e.ts, e.type, e.step_id, JSON.stringify(e.data), e.prev_hash, e.hash],
        );
      }
      if (this.syncFailed) console.log(`audit: central store reachable again, synced run ${this.runId}`);
      this.syncFailed = false;
    } catch (err) {
      if (!this.syncFailed) console.warn(`audit: central store unavailable, keeping events locally (${(err as Error).message})`);
      this.syncFailed = true;
    }
  }
}

/** Recomputes every hash in a run's log. Any edit, insertion or deletion breaks the chain. */
export function verifyChain(runDir: string): { valid: boolean; events: number; head: string; broken_at?: number } {
  const events = readAudit(runDir);
  let prev = GENESIS;
  for (const e of events) {
    const { hash, ...rest } = e;
    if (e.prev_hash !== prev || eventHash(rest) !== hash) return { valid: false, events: events.length, head: prev, broken_at: e.seq };
    prev = hash;
  }
  return { valid: true, events: events.length, head: prev };
}

export async function upsertRunRow(run: { run_id: string; recipe_id: string; recipe_version: string; mode: string; status: string }, manifest: unknown = null) {
  if (config.auditMode !== "central") return;
  try {
    await db().query(
      `insert into runs (run_id, recipe, recipe_version, mode, status, manifest) values ($1,$2,$3,$4,$5,$6)
       on conflict (run_id) do update set status = excluded.status, manifest = coalesce(excluded.manifest, runs.manifest), updated_at = now()`,
      [run.run_id, run.recipe_id, run.recipe_version, run.mode, run.status, manifest === null ? null : JSON.stringify(manifest)],
    );
  } catch {
    /* central store optional for run rows */
  }
}
