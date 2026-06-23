/**
 * src/lib/ai/semantic-cache, semantic fallback layer for the AI response cache.
 *
 * When the exact sha256 cache (response-cache.ts) misses, this module
 * looks for a semantically-similar prior prompt for the SAME feature and
 * reuses its response if cosine similarity >= threshold (default 0.92).
 *
 * This turns Instinct's "cost-efficiency" claim into a measurable token
 * reduction: identical prompts are caught by the exact-hash cache; near-
 * duplicate prompts (different wording, same intent) are caught here.
 *
 * Design:
 *   - VectorStore is a pluggable interface. Tests supply inMemoryVectorStore().
 *     Production uses qdrantVectorStore() which wraps src/lib/brain/qdrant.ts.
 *   - Feature isolation is enforced in every lookup: a "support.draft" entry
 *     never matches a "meeting.summary" query regardless of embedding proximity.
 *   - qdrantVectorStore degrades gracefully: if QDRANT_URL is absent, or any
 *     Qdrant call throws, upsert is a no-op and nearest returns null.
 *     The calling gateway must never break because Qdrant is down.
 *   - No Date.now, Math.random, or new npm deps.
 */

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface SemanticEntry {
  feature: string;
  embedding: number[];
  response: string;
  model_used: string;
}

export interface SemanticHit {
  response: string;
  model_used: string;
  similarity: number;
}

/**
 * Pluggable vector store so tests can supply a deterministic in-memory
 * fake while production uses Qdrant.
 */
export interface VectorStore {
  upsert(e: SemanticEntry): Promise<void>;
  nearest(
    feature: string,
    embedding: number[],
  ): Promise<{ entry: SemanticEntry; similarity: number } | null>;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Cosine similarity between two numeric vectors.
 *
 * Returns 0 (not an error) for:
 *   - either vector having zero magnitude
 *   - vectors of differing lengths
 *
 * Pure and deterministic; suitable for direct use in tests.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* ------------------------------------------------------------------ */
/* Analytics helper (pure, caller emits; we supply shape)            */
/* ------------------------------------------------------------------ */

export interface CacheEventMetadata {
  feature: string;
  semantic_hit: boolean;
  similarity: number;
}

/**
 * Build the metadata object for an `ai.semantic_cache` analytics event.
 * Pure; no side effects. The gateway calls trackEvent itself, this just
 * provides the canonical shape so every call site is consistent.
 */
export function buildCacheEventMetadata(
  hit: SemanticHit | null,
  feature: string,
): CacheEventMetadata {
  return {
    feature,
    semantic_hit: hit !== null,
    similarity: hit?.similarity ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* In-memory vector store (default / test)                            */
/* ------------------------------------------------------------------ */

/**
 * A simple in-memory vector store backed by a plain array.
 *
 * Linear scan is fine for tests and for small feature caches in
 * low-traffic deployments. Production should use qdrantVectorStore()
 * for sub-linear ANN.
 *
 * Each call to inMemoryVectorStore() returns an INDEPENDENT store so
 * tests can isolate state without any beforeEach cleanup.
 */
export function inMemoryVectorStore(): VectorStore {
  const entries: SemanticEntry[] = [];

  return {
    async upsert(e: SemanticEntry): Promise<void> {
      // Replace existing entry with same feature+embedding fingerprint,
      // otherwise append. This keeps the store compact for long-running
      // in-memory usage (e.g. integration tests that upsert repeatedly).
      const idx = entries.findIndex(
        (x) =>
          x.feature === e.feature &&
          x.embedding.length === e.embedding.length &&
          x.embedding.every((v, i) => v === e.embedding[i]),
      );
      if (idx >= 0) {
        entries[idx] = e;
      } else {
        entries.push(e);
      }
    },

    async nearest(
      feature: string,
      embedding: number[],
    ): Promise<{ entry: SemanticEntry; similarity: number } | null> {
      let best: { entry: SemanticEntry; similarity: number } | null = null;

      for (const candidate of entries) {
        // Feature isolation: only consider entries for the same feature.
        if (candidate.feature !== feature) continue;

        const sim = cosineSimilarity(candidate.embedding, embedding);
        if (best === null || sim > best.similarity) {
          best = { entry: candidate, similarity: sim };
        }
      }

      return best;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Qdrant vector store (production)                                   */
/* ------------------------------------------------------------------ */

const SEMANTIC_CACHE_COLLECTION =
  process.env.SEMANTIC_CACHE_QDRANT_COLLECTION || "instinct_semantic_cache";

/**
 * Qdrant-backed vector store for the semantic cache.
 *
 * Uses the same HTTP pattern as src/lib/brain/qdrant.ts, raw fetch
 * against QDRANT_URL, no new dependency. Collection size is fixed at
 * the embedding dimension inferred from the first upserted entry; if
 * dimensions mismatch the ensureCollection step will no-op (the
 * collection already exists at the prior dim).
 *
 * Degrades gracefully: if QDRANT_URL is absent, or any network/parse
 * error occurs, upsert is a no-op and nearest returns null. The
 * gateway call site must never break because Qdrant is down.
 */
export function qdrantVectorStore(
  collection: string = SEMANTIC_CACHE_COLLECTION,
): VectorStore {
  function getUrl(): string | null {
    return process.env.QDRANT_URL || null;
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = process.env.QDRANT_API_KEY;
    if (key) h["api-key"] = key;
    return h;
  }

  /**
   * Stable numeric ID for a (feature, embedding) pair.
   *
   * We need a deterministic integer for Qdrant's point ID. We hash the
   * feature string and the first 8 elements of the embedding together
   * using a simple polynomial accumulator. Collisions are acceptable:
   * the payload carries the full feature + embedding, so a collision
   * just overwrites an unrelated entry in the worst case, a cache
   * false-positive, not a crash.
   */
  function pointId(feature: string, embedding: number[]): number {
    let h = 0;
    for (let i = 0; i < feature.length; i++) {
      h = (h * 31 + feature.charCodeAt(i)) >>> 0;
    }
    const slice = embedding.slice(0, 8);
    for (let i = 0; i < slice.length; i++) {
      // Quantize each float to an integer bit-pattern using a fixed
      // multiplier, avoids floating-point non-determinism issues.
      const q = Math.round(slice[i] * 1e4) & 0xffff;
      h = (h * 31 + q) >>> 0;
    }
    return h || 1; // Qdrant requires non-zero IDs
  }

  async function ensureCollection(url: string, dim: number): Promise<void> {
    try {
      const check = await fetch(`${url}/collections/${collection}`, {
        headers: headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (check.ok) return; // already exists
    } catch {
      return; // can't reach Qdrant, degrade silently
    }
    try {
      await fetch(`${url}/collections/${collection}`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({
          vectors: { size: dim, distance: "Cosine" },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Collection creation is best-effort
    }
  }

  return {
    async upsert(e: SemanticEntry): Promise<void> {
      const url = getUrl();
      if (!url) return; // no Qdrant configured, silently no-op

      try {
        await ensureCollection(url, e.embedding.length);
        const pid = pointId(e.feature, e.embedding);

        await fetch(`${url}/collections/${collection}/points?wait=true`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({
            points: [
              {
                id: pid,
                vector: e.embedding,
                payload: {
                  feature: e.feature,
                  response: e.response,
                  model_used: e.model_used,
                  // Store a compact fingerprint of the embedding for
                  // exact-match deduplication in nearest().
                  embedding_head: e.embedding.slice(0, 8),
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Qdrant down / network error, degrade silently, never throw
      }
    },

    async nearest(
      feature: string,
      embedding: number[],
    ): Promise<{ entry: SemanticEntry; similarity: number } | null> {
      const url = getUrl();
      if (!url) return null;

      try {
        const res = await fetch(
          `${url}/collections/${collection}/points/search`,
          {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              vector: embedding,
              limit: 1,
              with_payload: true,
              filter: {
                must: [
                  {
                    key: "feature",
                    match: { value: feature },
                  },
                ],
              },
            }),
            signal: AbortSignal.timeout(5000),
          },
        );

        if (!res.ok) return null;

        const data = (await res.json()) as {
          result?: {
            score: number;
            payload: {
              feature: string;
              response: string;
              model_used: string;
              embedding_head?: number[];
            };
          }[];
        };

        const top = data.result?.[0];
        if (!top) return null;

        // Feature isolation: Qdrant's payload filter already enforces
        // this, but double-check defensively in case of stale data.
        if (top.payload.feature !== feature) return null;

        return {
          entry: {
            feature: top.payload.feature,
            // We don't store the full embedding in Qdrant payload
            // (too large); reconstruct a minimal stand-in for the
            // interface. The similarity is computed server-side by
            // Qdrant so we don't need the stored vector here.
            embedding: top.payload.embedding_head ?? [],
            response: top.payload.response,
            model_used: top.payload.model_used,
          },
          similarity: top.score,
        };
      } catch {
        // Qdrant down / parse error, degrade to null, never throw
        return null;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Default module-level store (used when callers omit store arg)      */
/* ------------------------------------------------------------------ */

// Lazily initialized so tests that import this module before setting
// env vars don't accidentally spin up a Qdrant connection.
let _defaultStore: VectorStore | null = null;

function getDefaultStore(): VectorStore {
  if (!_defaultStore) {
    // Use Qdrant if configured; fall back to in-memory.
    _defaultStore = process.env.QDRANT_URL
      ? qdrantVectorStore()
      : inMemoryVectorStore();
  }
  return _defaultStore;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Look up a semantically-similar cached response.
 *
 * Returns a SemanticHit only when:
 *   1. The best candidate has the same `feature` as the query.
 *   2. Cosine similarity >= threshold (default 0.92).
 *
 * Returns null on any miss or store error. Never throws.
 */
export async function semanticLookup(args: {
  feature: string;
  embedding: number[];
  threshold?: number;
  store?: VectorStore;
}): Promise<SemanticHit | null> {
  const { feature, embedding, threshold = 0.92, store } = args;
  const vs = store ?? getDefaultStore();

  try {
    const result = await vs.nearest(feature, embedding);
    if (!result) return null;
    if (result.similarity < threshold) return null;

    return {
      response: result.entry.response,
      model_used: result.entry.model_used,
      similarity: result.similarity,
    };
  } catch {
    // Store error, degrade to null, never throw into the gateway
    return null;
  }
}

/**
 * Persist a SemanticEntry so future semanticLookup calls can find it.
 *
 * Never throws. Store errors are silently swallowed, a write failure
 * means the next request might not get a semantic hit, but it won't
 * break the gateway.
 */
export async function semanticStore(args: {
  entry: SemanticEntry;
  store?: VectorStore;
}): Promise<void> {
  const { entry, store } = args;
  const vs = store ?? getDefaultStore();

  try {
    await vs.upsert(entry);
  } catch {
    // Best-effort, never throw into the caller
  }
}
