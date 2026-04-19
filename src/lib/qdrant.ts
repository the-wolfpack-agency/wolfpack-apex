/**
 * Qdrant Client — Vector store for Instinct knowledge embeddings.
 *
 * Triple-write secondary store. Stores question+answer as vector points
 * for semantic similarity search. Uses pseudo-embeddings (4-dim zero vector)
 * until a real embedding provider (OpenAI) is configured.
 *
 * All operations are fire-and-forget — never throw, never block.
 */

const COLLECTION = "apex_knowledge";

function getQdrantUrl(): string | null {
  return process.env.QDRANT_URL || null;
}

/**
 * Store a knowledge point as a vector in Qdrant.
 * Uses a 4-dim zero vector with rich metadata payload.
 * Real embeddings will replace the zero vector when OpenAI key is added.
 */
export async function upsertKnowledgePoint(
  id: string,
  question: string,
  answer: string,
  source: string,
  tags: string[],
  repo?: string,
): Promise<void> {
  const url = getQdrantUrl();
  if (!url) return;

  try {
    // Ensure collection exists (idempotent)
    await ensureCollection(url);

    // Hash-based pseudo-embedding (4-dim zero vector with metadata)
    const vector = [0, 0, 0, 0];

    await fetch(`${url}/collections/${COLLECTION}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          {
            id: hashToInt(id),
            vector,
            payload: {
              original_id: id,
              question,
              answer: answer.slice(0, 500),
              source,
              tags,
              repo: repo ?? null,
              indexed_at: new Date().toISOString(),
            },
          },
        ],
      }),
    });
  } catch {
    // Fire-and-forget — never throw
  }
}

/**
 * Search for semantically similar questions.
 * Without real embeddings, returns empty results.
 */
export async function searchSimilarQuestions(
  _question: string,
  _limit: number = 5,
): Promise<Array<{ id: string; question: string; score: number }>> {
  const url = getQdrantUrl();
  if (!url) return [];

  // Without real embeddings, semantic search is not meaningful.
  // Return empty until OpenAI embeddings are integrated.
  return [];
}

/**
 * Check Qdrant health via /healthz endpoint.
 */
export async function getQdrantHealth(): Promise<boolean> {
  const url = getQdrantUrl();
  if (!url) return false;

  try {
    const res = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureCollection(url: string): Promise<void> {
  try {
    const check = await fetch(`${url}/collections/${COLLECTION}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (check.ok) return;

    await fetch(`${url}/collections/${COLLECTION}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: 4, distance: "Cosine" },
      }),
    });
  } catch {
    // Collection creation is best-effort
  }
}

/**
 * Convert a string ID to a positive integer for Qdrant point ID.
 */
function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash || 1; // Qdrant requires non-zero IDs
}

// Export for testing
export { COLLECTION, hashToInt, ensureCollection };
