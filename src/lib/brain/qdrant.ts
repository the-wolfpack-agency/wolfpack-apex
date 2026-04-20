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

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
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
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  const res = await fetch(`${QDRANT_URL}${path}`, {
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

export async function searchBrain(
  queryVector: number[],
  limit: number,
  filter?: Record<string, unknown>,
): Promise<SemanticHit[]> {
  const body: Record<string, unknown> = {
    vector: queryVector,
    limit,
    with_payload: true,
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

export async function brainHealth(): Promise<boolean> {
  try {
    await qd("GET", "/collections");
    return true;
  } catch {
    return false;
  }
}
