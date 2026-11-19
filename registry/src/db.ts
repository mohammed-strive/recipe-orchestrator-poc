import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://poc:poc@localhost:5433/orchestrator",
  max: 5,
});

export async function waitForDb(timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await pool.query("select 1 from components limit 1");
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
