// Recipe selection: semantic + keyword match of the user's request against recipe
// descriptions. The result is a proposal; the user (or an explicit recipe id) decides.
import { config } from "./config.js";
import { flatSteps, loadRecipes } from "./recipe.js";

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2));
}

async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][] | null> {
  try {
    const res = await fetch(`${config.embeddingsUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts, kind }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { vectors: number[][] }).vectors;
  } catch {
    return null;
  }
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export async function findRecipes(request: string, limit = 3) {
  const recipes = loadRecipes();
  const docs = recipes.map(({ recipe: r }) =>
    [r.title, r.description, `Industry: ${r.industry ?? ""}`, `Tags: ${(r.tags ?? []).join(", ")}`,
     ...r.blocks.map((b) => b.title ?? b.id), ...flatSteps(r).map((s) => s.task ?? s.title ?? "")].join("\n"));
  const q = words(request);
  const vectors = await embed([request, ...docs], "passage");
  const scored = recipes.map((lr, i) => {
    const d = words(docs[i]);
    const overlap = [...q].filter((w) => d.has(w));
    const keyword = q.size ? overlap.length / q.size : 0;
    const semantic = vectors ? cosine(vectors[0], vectors[i + 1]) : null;
    const score = semantic === null ? keyword : 0.7 * semantic + 0.3 * keyword;
    return {
      recipe_id: `${lr.recipe.recipe}@${lr.recipe.version}`,
      title: lr.recipe.title,
      description: lr.recipe.description,
      industry: lr.recipe.industry,
      score: Number(score.toFixed(3)),
      matched_terms: overlap,
      scoring: semantic === null ? "keyword only (embeddings service unreachable)" : "0.7 semantic + 0.3 keyword",
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
