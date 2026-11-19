// Embedding client. "service" calls the local embeddings container; "hash" is a
// deterministic bag-of-words fallback for offline development and tests only.
import { createHash } from "node:crypto";

export const DIM = 384;
const MODE = process.env.EMBEDDINGS_MODE ?? "service";
const URL_ = process.env.EMBEDDINGS_URL ?? "http://localhost:7200";

export function embedModelName(): string {
  return MODE === "hash" ? "hash-bow-384" : (process.env.EMBED_MODEL ?? "BAAI/bge-small-en-v1.5");
}

export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (MODE === "hash") return texts.map(hashEmbed);
  const res = await fetch(`${URL_}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts, kind }),
  });
  if (!res.ok) throw new Error(`embeddings service returned ${res.status}`);
  const body = (await res.json()) as { vectors: number[][] };
  return body.vectors;
}

export async function waitForEmbeddings(timeoutMs = 180_000): Promise<void> {
  if (MODE === "hash") return;
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${URL_}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`embeddings service not reachable at ${URL_}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    const h = createHash("sha1").update(w).digest();
    const idx = h.readUInt16BE(0) % DIM;
    v[idx] += h[2] % 2 === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
