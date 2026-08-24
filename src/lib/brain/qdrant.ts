/**
 * Qdrant client scoped to the `apex_brain` collection.
 *
 * Deliberately a separate collection from `instinct_knowledge` — different
 * dim (1536 vs 4), different payload shape, and upgrade cadence of the
 * two systems is independent. A failure in either never takes the other
 * down.
 *
 * Every operation is best-effort: callers wrap in try/catch and
 * degrade to keyword-only retrieval. We log failures via analytics so
 * the eval harness can correlate retrieval-quality dips with Qdrant
 * health without needing ops access.
 */

import { EMBED_DIM } from "./embedder";
import { resolveServiceUrl } from "@/lib/config/local-default";

/**
 * Resolved per call, not at module load, and never as loopback in a deployed
 * function — 127.0.0.1 there is this container, so the request fails with a
 * network error that reads as "Qdrant is down" when the truth is that
 * QDRANT_URL is unset. Same shape as the DMS driver incident (2026-08-02).
 *
 * QDRANT_URL is a documented deployment blocker, so this should never fire in
 * production; it fires when the variable has been emptied rather than set,
 * which is exactly the state a redacted `vercel env pull` leaves behind.
 */
function qdrantEndpoint() {
  return resolveServiceUrl("QDRANT_URL", "http://localhost:6333");
}
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
export const BRAIN_COLLECTION = process.env.BRAIN_QDRANT_COLLECTION || "apex_brain";

interface QdrantPayload {
  document_id: string;
  chunk_id: string;
  chunk_idx: number;
  filename: string;
  kind: string;
  uploaded_by: string;
  tags: string[];
  content: string;
  created_at: string;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: QdrantPayload;
}

export interface SemanticHit {
  chunk_id: string;
  document_id: string;
  chunk_idx: number;
  filename: string;
  content: string;
  score: number;
}

async function qd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const endpoint = qdrantEndpoint();
  if (!endpoint.configured) {
    // Thrown, not swallowed: every caller here already wraps in try/catch and
    // degrades to Postgres-only, so this surfaces as a named configuration
    // fault in the logs instead of an ECONNREFUSED nobody can interpret.
    throw new Error(`qdrant not configured: ${endpoint.reason}`);
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  const res = await fetch(`${endpoint.url}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`qdrant ${method} ${path} -> ${res.status}: ${detail.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Create the collection if it doesn't already exist. Idempotent —
 * existing collection with matching dim is a no-op.
 */
export async function ensureBrainCollection(): Promise<void> {
  try {
    await qd("GET", `/collections/${BRAIN_COLLECTION}`);
    return; // already there
  } catch {
    // fall through to create
  }
  await qd("PUT", `/collections/${BRAIN_COLLECTION}`, {
    vectors: { size: EMBED_DIM, distance: "Cosine" },
  });
  // Payload indexes make payload filters cheap
  for (const field of ["document_id", "uploaded_by", "kind"]) {
    try {
      await qd("PUT", `/collections/${BRAIN_COLLECTION}/index`, {
        field_name: field,
        field_schema: "keyword",
      });
    } catch {
      // indexes are optional; collection still works
    }
  }
}

export async function upsertBrainPoints(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return;
  await ensureBrainCollection();
  await qd("PUT", `/collections/${BRAIN_COLLECTION}/points?wait=true`, {
    points,
  });
}

export async function deleteByDocumentId(documentId: string): Promise<void> {
  try {
    await qd("POST", `/collections/${BRAIN_COLLECTION}/points/delete?wait=true`, {
      filter: {
        must: [{ key: "document_id", match: { value: documentId } }],
      },
    });
  } catch {
    // best-effort — if qdrant is down the row still gets removed from PG
  }
}

/**
 * HOW CLOSE COUNTS AS RELEVANT.
 *
 * A vector search returns the k nearest neighbours whether or not any of them
 * are near. Without a floor, every query gets an answer: on 2026-08-24, the
 * first run after the embedding backfill returned five hits for 60 out of 60
 * real queries, including "1111-1212-3232-4321" confidently matched to a
 * mobile-coaching spreadsheet and "171 state street New York, NY" to a session
 * export. Switching semantic on had made the wrong-answer problem universal
 * rather than fixing it.
 *
 * Measured against this index, cosine, text-embedding-3-small:
 *
 *   things we hold          0.3872 .. 0.5986   (leadership team, demo vehicle,
 *                                               onboarding, dinner receipt)
 *   things we do not        0.2322 .. 0.3432   (a card number, a street
 *                                               address, weather, "thanks",
 *                                               bicycle punctures, gibberish)
 *
 * 0.36 sits in the gap. Unlike the keyword score, which put "yes" above every
 * genuine question and could not be thresholded at all, these two populations
 * genuinely separate.
 *
 * Erring low costs a confident wrong answer; erring high costs an "I don't
 * know" for something we hold. After the day this was found, the second is the
 * better failure.
 */
export const SEMANTIC_SCORE_FLOOR = 0.36;

export async function searchBrain(
  queryVector: number[],
  limit: number,
  filter?: Record<string, unknown>,
): Promise<SemanticHit[]> {
  const body: Record<string, unknown> = {
    vector: queryVector,
    limit,
    with_payload: true,
    /* Applied by Qdrant rather than by us, so a distant neighbour is never
       fetched, never scored and never has the chance to be quoted. */
    score_threshold: SEMANTIC_SCORE_FLOOR,
  };
  if (filter) body.filter = filter;

  const res = await qd<{
    result: { id: string; score: number; payload: QdrantPayload }[];
  }>("POST", `/collections/${BRAIN_COLLECTION}/points/search`, body);

  return (res.result || []).map((r) => ({
    chunk_id: r.payload.chunk_id,
    document_id: r.payload.document_id,
    chunk_idx: r.payload.chunk_idx,
    filename: r.payload.filename,
    content: r.payload.content,
    score: r.score,
  }));
}

/**
 * Fetch the raw vectors for a batch of Qdrant point ids. Used by the
 * Brain Pack endpoint so we can ship embeddings client-side for Level-2
 * ANN without leaking our Qdrant URL. Returns a Map keyed by point_id;
 * missing ids are simply absent from the map (never throws per-point).
 *
 * If the whole Qdrant call fails (network, 5xx) we return an empty Map
 * rather than throwing — callers degrade to a fingerprint-only pack.
 */
export async function fetchBrainVectors(
  pointIds: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (pointIds.length === 0) return out;
  try {
    const res = await qd<{
      result: { id: string; vector?: number[] | Record<string, number[]> }[];
    }>("POST", `/collections/${BRAIN_COLLECTION}/points`, {
      ids: pointIds,
      with_vector: true,
      with_payload: false,
    });
    for (const p of res.result || []) {
      const v = Array.isArray(p.vector)
        ? p.vector
        : p.vector && typeof p.vector === "object"
          ? Object.values(p.vector).find(Array.isArray) ?? null
          : null;
      if (v && v.length > 0) out.set(String(p.id), v);
    }
  } catch {
    // best-effort — pack caller sees "no vectors available" and ships
    // chunks without embeddings. Level-2 ANN degrades to keyword-only.
  }
  return out;
}

export async function brainHealth(): Promise<boolean> {
  try {
    await qd("GET", "/collections");
    return true;
  } catch {
    return false;
  }
}
