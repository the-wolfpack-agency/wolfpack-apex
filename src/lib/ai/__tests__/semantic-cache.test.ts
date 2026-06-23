/**
 * semantic-cache, unit tests.
 *
 * Covers:
 *   1.  cosineSimilarity: identical vectors → 1
 *   2.  cosineSimilarity: orthogonal vectors → 0
 *   3.  cosineSimilarity: zero vector (a) → 0
 *   4.  cosineSimilarity: zero vector (b) → 0
 *   5.  cosineSimilarity: length mismatch → 0
 *   6.  cosineSimilarity: empty arrays → 0
 *   7.  cosineSimilarity: known value (non-trivial angle)
 *   8.  inMemoryVectorStore: upsert + nearest returns stored entry
 *   9.  inMemoryVectorStore: nearest returns null when store is empty
 *   10. inMemoryVectorStore: feature isolation, different feature returns null
 *   11. inMemoryVectorStore: upsert replaces entry with same embedding
 *   12. semanticLookup: hit above threshold returns SemanticHit
 *   13. semanticLookup: miss below threshold returns null
 *   14. semanticLookup: feature isolation, wrong feature returns null even if similar
 *   15. semanticLookup: empty store returns null
 *   16. semanticLookup: custom threshold respected
 *   17. semanticLookup: store.nearest throwing degrades to null (never throws)
 *   18. semanticStore: stores entry and is retrievable via semanticLookup
 *   19. semanticStore: store.upsert throwing degrades silently (never throws)
 *   20. qdrantVectorStore: upsert is no-op when QDRANT_URL unset (no throw)
 *   21. qdrantVectorStore: nearest returns null when QDRANT_URL unset (no throw)
 *   22. qdrantVectorStore: nearest returns null when fetch throws (Qdrant down)
 *   23. qdrantVectorStore: upsert no-ops when fetch throws (Qdrant down)
 *   24. buildCacheEventMetadata: hit path → semantic_hit=true, correct similarity
 *   25. buildCacheEventMetadata: null hit path → semantic_hit=false, similarity=0
 *   26. buildCacheEventMetadata: feature is passed through correctly
 */

import {
  cosineSimilarity,
  inMemoryVectorStore,
  qdrantVectorStore,
  semanticLookup,
  semanticStore,
  buildCacheEventMetadata,
} from "../semantic-cache";
import type { SemanticEntry, SemanticHit, VectorStore } from "../semantic-cache";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function entry(
  feature: string,
  embedding: number[],
  response = "cached response",
  model_used = "claude-3-haiku",
): SemanticEntry {
  return { feature, embedding, response, model_used };
}

/* ------------------------------------------------------------------ */
/* 1-7: cosineSimilarity                                              */
/* ------------------------------------------------------------------ */

describe("cosineSimilarity", () => {
  test("identical vectors → 1", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  test("zero vector a → 0", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  test("zero vector b → 0", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  test("both zero vectors → 0", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  test("length mismatch → 0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  test("empty arrays → 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("known non-trivial angle", () => {
    // [1, 0] and [1, 1] normalized: cos(45°) = 1/√2 ≈ 0.7071
    const result = cosineSimilarity([1, 0], [1, 1]);
    expect(result).toBeCloseTo(1 / Math.sqrt(2), 5);
  });
});

/* ------------------------------------------------------------------ */
/* 8-11: inMemoryVectorStore                                          */
/* ------------------------------------------------------------------ */

describe("inMemoryVectorStore", () => {
  test("upsert + nearest returns stored entry", async () => {
    const store = inMemoryVectorStore();
    const e = entry("support.draft", [1, 0, 0]);
    await store.upsert(e);
    const result = await store.nearest("support.draft", [1, 0, 0]);
    expect(result).not.toBeNull();
    expect(result!.entry.response).toBe("cached response");
    expect(result!.similarity).toBeCloseTo(1, 10);
  });

  test("nearest returns null when store is empty", async () => {
    const store = inMemoryVectorStore();
    const result = await store.nearest("support.draft", [1, 0, 0]);
    expect(result).toBeNull();
  });

  test("feature isolation, different feature returns null", async () => {
    const store = inMemoryVectorStore();
    await store.upsert(entry("support.draft", [1, 0, 0]));
    // Same embedding, different feature, must not match
    const result = await store.nearest("meeting.summary", [1, 0, 0]);
    expect(result).toBeNull();
  });

  test("upsert replaces entry with same embedding", async () => {
    const store = inMemoryVectorStore();
    const vec = [1, 0, 0];
    await store.upsert(entry("support.draft", vec, "first response"));
    await store.upsert(entry("support.draft", vec, "second response"));
    const result = await store.nearest("support.draft", vec);
    expect(result!.entry.response).toBe("second response");
  });

  test("nearest returns best match among multiple entries", async () => {
    const store = inMemoryVectorStore();
    // [1,0,0] and [0.9,0.1,0] are close; [0,0,1] is far from query [1,0,0]
    await store.upsert(entry("support.draft", [0.9, 0.1, 0], "close"));
    await store.upsert(entry("support.draft", [0, 0, 1], "far"));
    const result = await store.nearest("support.draft", [1, 0, 0]);
    expect(result!.entry.response).toBe("close");
  });
});

/* ------------------------------------------------------------------ */
/* 12-19: semanticLookup + semanticStore                              */
/* ------------------------------------------------------------------ */

describe("semanticLookup", () => {
  test("hit above default threshold (0.92) returns SemanticHit", async () => {
    const store = inMemoryVectorStore();
    const vec = [1, 0, 0];
    await semanticStore({
      entry: entry("support.draft", vec, "response A"),
      store,
    });
    const hit = await semanticLookup({
      feature: "support.draft",
      embedding: vec,
      store,
    });
    expect(hit).not.toBeNull();
    expect(hit!.response).toBe("response A");
    expect(hit!.similarity).toBeCloseTo(1, 5);
    expect(hit!.model_used).toBe("claude-3-haiku");
  });

  test("miss below threshold returns null", async () => {
    const store = inMemoryVectorStore();
    // [1,0] vs [0.5, 0.866] has cosine ≈ 0.5, well below 0.92
    await semanticStore({
      entry: entry("support.draft", [1, 0]),
      store,
    });
    const hit = await semanticLookup({
      feature: "support.draft",
      embedding: [0.5, 0.866],
      store,
    });
    expect(hit).toBeNull();
  });

  test("feature isolation, wrong feature returns null even with identical embedding", async () => {
    const store = inMemoryVectorStore();
    const vec = [1, 0, 0];
    await semanticStore({
      entry: entry("support.draft", vec, "draft response"),
      store,
    });
    const hit = await semanticLookup({
      feature: "meeting.summary",
      embedding: vec,
      store,
    });
    expect(hit).toBeNull();
  });

  test("empty store returns null", async () => {
    const store = inMemoryVectorStore();
    const hit = await semanticLookup({
      feature: "support.draft",
      embedding: [1, 0, 0],
      store,
    });
    expect(hit).toBeNull();
  });

  test("custom threshold respected", async () => {
    const store = inMemoryVectorStore();
    // [1,0] vs [1,0]: similarity = 1.0, passes even a 0.99 threshold
    await semanticStore({ entry: entry("support.draft", [1, 0]), store });
    const hitHigh = await semanticLookup({
      feature: "support.draft",
      embedding: [1, 0],
      threshold: 0.99,
      store,
    });
    expect(hitHigh).not.toBeNull();

    // [1,0] vs [0.9, 0.436]: similarity ≈ 0.9, below 0.95 threshold
    const hitMiss = await semanticLookup({
      feature: "support.draft",
      embedding: [0.9, 0.436],
      threshold: 0.95,
      store,
    });
    expect(hitMiss).toBeNull();
  });

  test("store.nearest throwing degrades to null and does not throw", async () => {
    const brokenStore: VectorStore = {
      upsert: async () => {},
      nearest: async () => {
        throw new Error("store exploded");
      },
    };
    // Must not throw
    const hit = await semanticLookup({
      feature: "support.draft",
      embedding: [1, 0],
      store: brokenStore,
    });
    expect(hit).toBeNull();
  });
});

describe("semanticStore", () => {
  test("stores entry and is retrievable via semanticLookup", async () => {
    const store = inMemoryVectorStore();
    await semanticStore({
      entry: entry("support.categorize", [0, 1, 0], "cat response"),
      store,
    });
    const hit = await semanticLookup({
      feature: "support.categorize",
      embedding: [0, 1, 0],
      store,
    });
    expect(hit!.response).toBe("cat response");
  });

  test("store.upsert throwing degrades silently and does not throw", async () => {
    const brokenStore: VectorStore = {
      upsert: async () => {
        throw new Error("upsert exploded");
      },
      nearest: async () => null,
    };
    // Must not throw
    await expect(
      semanticStore({ entry: entry("support.draft", [1, 0]), store: brokenStore }),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 20-23: qdrantVectorStore graceful degradation                      */
/* ------------------------------------------------------------------ */

describe("qdrantVectorStore, unconfigured (QDRANT_URL absent)", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.QDRANT_URL;
    delete process.env.QDRANT_URL;
  });

  afterEach(() => {
    if (originalUrl !== undefined) {
      process.env.QDRANT_URL = originalUrl;
    } else {
      delete process.env.QDRANT_URL;
    }
  });

  test("upsert is a no-op when QDRANT_URL unset, does not throw", async () => {
    const store = qdrantVectorStore("test_collection");
    await expect(
      store.upsert(entry("support.draft", [1, 0, 0])),
    ).resolves.toBeUndefined();
  });

  test("nearest returns null when QDRANT_URL unset, does not throw", async () => {
    const store = qdrantVectorStore("test_collection");
    const result = await store.nearest("support.draft", [1, 0, 0]);
    expect(result).toBeNull();
  });
});

describe("qdrantVectorStore, Qdrant configured but down (fetch throws)", () => {
  let originalUrl: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalUrl = process.env.QDRANT_URL;
    process.env.QDRANT_URL = "http://qdrant-down.example.com:6333";
    originalFetch = global.fetch;
    // Simulate Qdrant being unreachable
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl !== undefined) {
      process.env.QDRANT_URL = originalUrl;
    } else {
      delete process.env.QDRANT_URL;
    }
  });

  test("nearest returns null when fetch throws, does not throw", async () => {
    const store = qdrantVectorStore("test_collection");
    const result = await store.nearest("support.draft", [1, 0, 0]);
    expect(result).toBeNull();
  });

  test("upsert no-ops when fetch throws, does not throw", async () => {
    const store = qdrantVectorStore("test_collection");
    await expect(
      store.upsert(entry("support.draft", [1, 0, 0])),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 24-26: buildCacheEventMetadata                                     */
/* ------------------------------------------------------------------ */

describe("buildCacheEventMetadata", () => {
  test("hit path: semantic_hit=true with correct similarity", () => {
    const hit: SemanticHit = {
      response: "r",
      model_used: "m",
      similarity: 0.95,
    };
    const meta = buildCacheEventMetadata(hit, "support.draft");
    expect(meta).toEqual({
      feature: "support.draft",
      semantic_hit: true,
      similarity: 0.95,
    });
  });

  test("null hit path: semantic_hit=false, similarity=0", () => {
    const meta = buildCacheEventMetadata(null, "meeting.summary");
    expect(meta).toEqual({
      feature: "meeting.summary",
      semantic_hit: false,
      similarity: 0,
    });
  });

  test("feature is passed through correctly", () => {
    const meta = buildCacheEventMetadata(null, "support.categorize");
    expect(meta.feature).toBe("support.categorize");
  });
});
