/**
 * Factory brain: a small, never-throwing Qdrant REST client for the factory's OWN
 * vector collections (NOT the assistant's instinct_knowledge - see the brain
 * architecture note in factory-reuse-store.ts). Deliberately not the legacy
 * src/lib/qdrant.ts (which is knowledge-specific and still writes zero-vectors),
 * and not the rag-provider VectorStore adapter (an unwired TODO).
 *
 * Every op degrades gracefully: a missing config or any transport error yields a
 * falsy/empty result, never a throw, so the vector index can be down without ever
 * breaking a factory run - it just falls back to the keyword path.
 *
 * The collection is a DERIVED index: its authoritative source is the Postgres
 * corpus, so losing it is a re-index, not data loss.
 */
import { createHash } from "node:crypto";

export const FACTORY_REUSE_COLLECTION = "instinct_factory_reuse";

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface VectorPoint {
  id: number | string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface VectorHit {
  id: number | string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * Re-rank vector hits by similarity x confidence (authoritative confidence lives
 * in Postgres, looked up per hit key). Stable: a missing/1.0 confidence leaves the
 * order unchanged, so this is a no-op until outcomes move confidence. Pure.
 */
export function rerankByConfidence<T extends { score: number }>(
  hits: readonly T[],
  keyOf: (h: T) => string,
  confidence: ReadonlyMap<string, number>,
): T[] {
  return hits
    .map((h, i) => ({ h, i, w: h.score * (confidence.get(keyOf(h)) ?? 1) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.h);
}

/** Resolve config from env; null when Qdrant is not configured (fall back path). */
export function qdrantConfigFromEnv(): QdrantConfig | null {
  const url = process.env.QDRANT_URL;
  if (!url) return null;
  return { url, apiKey: process.env.QDRANT_API_KEY };
}

/** Deterministic unsigned-int point id from a stable key (52-bit, JS-safe). */
export function pointId(key: string): number {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 13);
  return parseInt(hex, 16);
}

function headers(cfg: QdrantConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h["api-key"] = cfg.apiKey;
  return h;
}

/** Create the collection if absent (idempotent). Returns false on any failure. */
export async function ensureCollection(cfg: QdrantConfig, collection: string, dim: number): Promise<boolean> {
  const f = cfg.fetchImpl ?? fetch;
  try {
    const exists = await f(`${cfg.url}/collections/${collection}`, { headers: headers(cfg) });
    if (exists.ok) return true;
    const res = await f(`${cfg.url}/collections/${collection}`, {
      method: "PUT",
      headers: headers(cfg),
      body: JSON.stringify({ vectors: { size: dim, distance: "Cosine" } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Upsert points. Returns false on any failure (caller keeps the Postgres row as
 *  un-embedded and retries later - the index is derived, so this is safe). */
export async function upsertPoints(cfg: QdrantConfig, collection: string, points: VectorPoint[]): Promise<boolean> {
  if (points.length === 0) return true;
  const f = cfg.fetchImpl ?? fetch;
  try {
    const res = await f(`${cfg.url}/collections/${collection}/points`, {
      method: "PUT",
      headers: headers(cfg),
      body: JSON.stringify({ points }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Similarity search with an exact-match payload filter (workspace+repo scoping is
 * passed in `must`). Returns [] on any failure. The filter is how tenant isolation
 * is enforced in the vector store - a query never crosses workspace/repo.
 */
export async function searchPoints(
  cfg: QdrantConfig,
  collection: string,
  vector: number[],
  must: Record<string, string>,
  limit: number,
): Promise<VectorHit[]> {
  if (vector.length === 0) return [];
  const f = cfg.fetchImpl ?? fetch;
  try {
    const res = await f(`${cfg.url}/collections/${collection}/points/search`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        filter: { must: Object.entries(must).map(([key, value]) => ({ key, match: { value } })) },
      }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { result?: Array<{ id: number | string; score: number; payload?: Record<string, unknown> }> };
    return (body.result ?? []).map((r) => ({ id: r.id, score: r.score, payload: r.payload ?? {} }));
  } catch {
    return [];
  }
}
