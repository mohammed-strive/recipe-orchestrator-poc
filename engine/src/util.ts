import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export const now = () => new Date().toISOString();

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashFile(path: string): string {
  return sha256(readFileSync(path));
}

/** Stable JSON: keys sorted, so equal values always hash the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function isFileValue(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("/") && existsSync(v) && statSync(v).isFile();
}

/** Hash of a port value: file contents for files, canonical JSON otherwise. */
export function hashValue(v: unknown): string {
  return isFileValue(v) ? hashFile(v) : sha256(canonical(v));
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in text");
  return JSON.parse(text.slice(start, end + 1));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
