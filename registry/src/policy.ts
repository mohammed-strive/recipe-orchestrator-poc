// Governance policy: which components may run in automatic mode without confirmation.
// Only components whose capability card is verified by the plugin owner are eligible.
import { readFileSync } from "node:fs";

const POLICY_FILE = process.env.POLICY_FILE ?? "/policy/policy.json";

export function preApprovedSet(): Set<string> {
  try {
    const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as { pre_approved?: string[] };
    return new Set(policy.pre_approved ?? []);
  } catch {
    return new Set();
  }
}

export function isPreApproved(set: Set<string>, plugin: string, component: string, cardStatus: string): boolean {
  return cardStatus === "verified" && set.has(`${plugin}#${component}`);
}
