// Replay: rebuild a completed run from its records, without calling any AI model or
// external system. Code steps are re-executed and must give byte-identical outputs;
// tool steps use their snapshots; agent steps use their recorded outputs.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "./audit.js";
import { cardFor, pluginDir } from "./materialize.js";
import { findStep, getRecipe } from "./recipe.js";
import { readOutputs, runPython } from "./steps/code.js";
import { loadRun, runDir } from "./store.js";
import { hashFile, hashValue, isFileValue, now, readJson } from "./util.js";

const safe = (key: string) => key.replace(/[^a-zA-Z0-9_.-]+/g, "_");

export async function replayRun(runId: string) {
  const state = loadRun(runId);
  if (state.status !== "completed") throw new Error(`only completed runs can be replayed (status: ${state.status})`);
  const lr = getRecipe(`${state.recipe_id}@${state.recipe_version}`);
  const base = runDir(runId);
  const replayDir = join(base, `replay-${now().replace(/[:.]/g, "-")}`);
  const origSteps = join(base, "steps");
  const newSteps = join(replayDir, "steps");
  const rewrite = (text: string) => text.split(origSteps).join(newSteps);

  const ordered = Object.entries(state.steps)
    .filter(([, s]) => s.status === "completed")
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
  const results: { step: string; method: string; match: boolean; detail?: string }[] = [];

  for (const [key, st] of ordered) {
    const src = join(origSteps, safe(key));
    const dst = join(newSteps, safe(key));
    mkdirSync(dst, { recursive: true });
    if (!st.component) {
      const step = findStep(lr.recipe, key);
      if (step?.foreach) {
        // Rebuild the merged loop outputs from the replayed iterations.
        const inner = (step.steps ?? []).filter((s) => !s.only_as_fallback);
        const last = inner[inner.length - 1].id;
        const iterations = Object.keys(state.steps).filter((k) => k.startsWith(`${key}[`) && k.endsWith(`].${last}`))
          .sort((a, b) => Number(a.match(/\[(\d+)\]/)![1]) - Number(b.match(/\[(\d+)\]/)![1]));
        mkdirSync(join(dst, "out"), { recursive: true });
        let ok = true;
        for (const [port, recordedHash] of Object.entries(st.output_hashes ?? {})) {
          const files = iterations.map((k) => rewrite(String(state.steps[k].outputs?.[port])));
          if (!files.every((f) => existsSync(f))) continue;
          const merged = join(dst, "out", `${port}.json`);
          writeFileSync(merged, JSON.stringify(files.flatMap((f) => readJson<unknown[]>(f)), null, 2));
          ok &&= hashFile(merged) === recordedHash;
        }
        results.push({ step: key, method: "loop-merge", match: ok });
      } else {
        results.push({ step: key, method: "human-decision", match: true, detail: st.approval?.decision });
      }
      continue;
    }

    const m = st.component.match(/^(.+)@(.+)#(.+)$/)!;
    const [, plugin, version, component] = m;
    const pdir = pluginDir(runId, plugin, version);
    const card = cardFor(pdir, component);
    const outName = st.fallback_from ? "fallback" : "out";

    if (card.kind === "code") {
      const inputs = rewrite(readFileSync(join(src, "inputs.json"), "utf8"));
      const inputsFile = join(dst, "inputs.json");
      writeFileSync(inputsFile, inputs);
      const outDir = join(dst, outName);
      mkdirSync(outDir, { recursive: true });
      const res = await runPython(join(pdir, card.entry), inputsFile, outDir, dst);
      if (res.code !== 0) {
        results.push({ step: key, method: "re-executed", match: false, detail: res.stderr.slice(-300) });
        continue;
      }
      const produced = Object.values(readOutputs({ outDir, card })).map(hashValue).sort();
      const recorded = Object.values(st.output_hashes ?? {}).sort();
      results.push({ step: key, method: "re-executed", match: JSON.stringify(produced) === JSON.stringify(recorded) });
    } else {
      cpSync(join(src, outName), join(dst, outName), { recursive: true });
      const copied = Object.values(st.outputs ?? {}).filter(isFileValue).map((f) => hashFile(rewrite(f))).sort();
      const recorded = Object.entries(st.output_hashes ?? {}).filter(([k]) => isFileValue(st.outputs?.[k])).map(([, h]) => h).sort();
      results.push({
        step: key,
        method: card.kind === "tool" ? "snapshot" : "recorded-ai-output",
        match: JSON.stringify(copied) === JSON.stringify(recorded),
      });
    }
  }

  const manifest = existsSync(join(base, "manifest.json")) ? readJson<{ outputs: Record<string, { sha256: string }> }>(join(base, "manifest.json")) : null;
  const finalMatches = Object.entries(manifest?.outputs ?? {}).map(([name, o]) => {
    const original = String(state.final_outputs?.[name] ?? "");
    const stepFile = Object.values(state.steps).flatMap((s) => Object.values(s.outputs ?? {})).find((v) => isFileValue(v) && hashFile(v) === o.sha256);
    const replayed = stepFile ? rewrite(String(stepFile)) : "";
    return { output: name, original: original ? hashFile(original) : null, replayed: replayed && existsSync(replayed) ? hashFile(replayed) : null };
  });
  const identical = results.every((r) => r.match) && finalMatches.every((f) => f.original && f.original === f.replayed);
  const summary = { replay_dir: replayDir, identical, steps: results, final_outputs: finalMatches };
  writeFileSync(join(replayDir, "replay-report.json"), JSON.stringify(summary, null, 2));
  await new AuditLog(runId, base).append("replay_completed", { identical, replay_dir: replayDir, mismatches: results.filter((r) => !r.match).map((r) => r.step) });
  return summary;
}
