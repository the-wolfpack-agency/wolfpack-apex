/**
 * @jest-environment jsdom
 *
 * brain-ann — Level-2 in-browser ANN search over cached Brain-pack
 * chunks. We inject deterministic fake vectors via the `loadChunks` +
 * `embed` test seams so the test never boots transformers.js and
 * never touches IDB. The `brain-pack-store` module is mocked with
 * `virtual: true` because U3 may not have landed its implementation
 * yet — we only need the `CachedChunk` type shape to exist.
 */

// Virtual mock: brain-pack-store may not exist on disk yet (U3 stream).
jest.mock(
  "@/lib/brain-pack-store",
  () => ({
    __esModule: true,
    getCachedChunks: jest.fn(async () => []),
    getPackStats: jest.fn(async () => ({ chunk_count: 0 })),
  }),
  { virtual: true },
);

import {
  searchCachedChunks,
  cosineSimilarity,
  type AnnSearchResult,
} from "@/lib/brain-ann";

interface StubChunk {
  id: string;
  doc_id: string;
  title?: string;
  text: string;
  embedding?: number[];
  chunk_index?: number;
}

function chunk(
  id: string,
  doc_id: string,
  text: string,
  embedding?: number[],
): StubChunk {
  return { id, doc_id, title: doc_id, text, embedding };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("returns 0 on length mismatch", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
  it("returns 0 on zero-length vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("searchCachedChunks — semantic ranking", () => {
  it("ranks chunks by cosine similarity and dedupes per doc_id", async () => {
    const chunks: StubChunk[] = [
      chunk("c1", "docA", "alpha beta gamma", [1, 0, 0]),
      chunk("c2", "docA", "alpha beta delta", [0.9, 0.1, 0]),
      chunk("c3", "docB", "epsilon zeta", [0, 1, 0]),
      chunk("c4", "docC", "alpha eta", [0.95, 0.05, 0]),
    ];

    const result: AnnSearchResult = await searchCachedChunks(
      "alpha query",
      "default",
      10,
      {
        loadChunks: async () => chunks as unknown as never,
        embed: async () => [1, 0, 0],
      },
    );

    // c2 is near-duplicate of c1 in doc A — one of them survives dedup,
    // c4 (doc C) and c3 (doc B) also survive because they are different
    // docs. Top result is docA with highest cosine.
    const docIds = result.hits.map((h) => h.document_id);
    expect(new Set(docIds).size).toBe(docIds.length); // all unique
    expect(docIds[0]).toBe("docA");
    expect(result.semantic_hits).toBeGreaterThan(0);
  });

  it("applies topK cutoff", async () => {
    const chunks: StubChunk[] = [];
    for (let i = 0; i < 20; i += 1) {
      chunks.push(
        chunk(`c${i}`, `doc${i}`, `text ${i}`, [Math.max(0, 1 - i / 20), 0, 0]),
      );
    }
    const result = await searchCachedChunks("q", "default", 3, {
      loadChunks: async () => chunks as unknown as never,
      embed: async () => [1, 0, 0],
    });
    expect(result.hits.length).toBe(3);
  });
});

describe("searchCachedChunks — keyword fallback", () => {
  it("falls back to keyword-only when embed returns null", async () => {
    const chunks: StubChunk[] = [
      chunk("c1", "docA", "alpha beta gamma"),
      chunk("c2", "docB", "epsilon zeta"),
    ];
    const result = await searchCachedChunks("alpha", "default", 10, {
      loadChunks: async () => chunks as unknown as never,
      embed: async () => null,
    });

    expect(result.semantic_hits).toBe(0);
    expect(result.keyword_hits).toBeGreaterThan(0);
    expect(result.hits[0].document_id).toBe("docA");
    expect(result.hits[0].source).toBe("keyword");
  });

  it("returns empty hits when pack is empty", async () => {
    const result = await searchCachedChunks("alpha", "default", 10, {
      loadChunks: async () => [],
      embed: async () => [1, 0, 0],
    });
    expect(result.hits).toHaveLength(0);
    expect(result.keyword_hits).toBe(0);
    expect(result.semantic_hits).toBe(0);
  });

  it("survives loadChunks throwing (returns empty)", async () => {
    const result = await searchCachedChunks("alpha", "default", 5, {
      loadChunks: async () => {
        throw new Error("idb error");
      },
      embed: async () => [1, 0, 0],
    });
    expect(result.hits).toHaveLength(0);
  });

  it("survives embed throwing (falls back to keyword)", async () => {
    const chunks: StubChunk[] = [
      chunk("c1", "docA", "alpha beta"),
    ];
    const result = await searchCachedChunks("alpha", "default", 5, {
      loadChunks: async () => chunks as unknown as never,
      embed: async () => {
        throw new Error("embed-boom");
      },
    });
    expect(result.semantic_hits).toBe(0);
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

describe("searchCachedChunks — merge", () => {
  it("tags source as 'keyword+semantic' when both branches score the same chunk", async () => {
    const chunks: StubChunk[] = [
      chunk("c1", "docA", "alpha beta", [1, 0, 0]),
    ];
    const result = await searchCachedChunks("alpha", "default", 5, {
      loadChunks: async () => chunks as unknown as never,
      embed: async () => [1, 0, 0],
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].source).toBe("keyword+semantic");
  });
});

describe("searchCachedChunks — analytics", () => {
  it("emits brain.ann_search_performed with chunk_count + top_k", async () => {
    const events: Array<[string, Record<string, string | number | boolean>]> =
      [];
    const chunks: StubChunk[] = [
      chunk("c1", "docA", "alpha", [1, 0, 0]),
      chunk("c2", "docB", "beta", [0, 1, 0]),
    ];
    await searchCachedChunks("alpha", "workspace-x", 4, {
      loadChunks: async () => chunks as unknown as never,
      embed: async () => [1, 0, 0],
      onAnalytics: (e, m) => events.push([e, m]),
    });
    const ev = events.find(([e]) => e === "brain.ann_search_performed");
    expect(ev).toBeDefined();
    expect(ev![1].workspace).toBe("workspace-x");
    expect(ev![1].chunk_count).toBe(2);
    expect(ev![1].top_k).toBe(4);
  });
});
