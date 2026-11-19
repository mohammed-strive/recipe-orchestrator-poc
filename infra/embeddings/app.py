"""Local embedding service for the capability registry and recipe search.

POST /embed  {"texts": [...], "kind": "query" | "passage"}
  -> {"model": ..., "dim": 384, "vectors": [[...], ...]}
GET  /health
"""
import os

from fastapi import FastAPI
from fastembed import TextEmbedding
from pydantic import BaseModel

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
model = TextEmbedding(MODEL_NAME)
app = FastAPI(title="embeddings")


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "passage"


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME}


@app.post("/embed")
def embed(req: EmbedRequest):
    if req.kind == "query":
        vectors = list(model.query_embed(req.texts))
    else:
        vectors = list(model.embed(req.texts))
    out = [[round(float(x), 6) for x in v] for v in vectors]
    return {"model": MODEL_NAME, "dim": len(out[0]) if out else 0, "vectors": out}
