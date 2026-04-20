/**
 * @jest-environment jsdom
 *
 * brain-rag-offline — wrapper contract tests.
 */

import "fake-indexeddb/auto";

// Virtual mock so brain-rag-offline's dynamic `import("@/lib/brain-pack-store")`
// resolves even before U3 lands that module on disk. The L2 tests below
// pass explicit `getPackStats` / `annSearch` seams so the dynamic import
// default path is only exercised in the negative "no pack" branch.
jest.mock(
  "@/lib/brain-pack-store",
  () => ({
    __esModule: true,
    getPackStats: jest.fn(async () => ({ chunk_count: 0 })),
    getCachedChunks: jest.fn(async () => []),
  }),
  { virtual: true },
);

import {
  queryBrainWithCache,
  RagOfflineMissError,
  type BrainQueryHit,
} from "@/lib/brain-rag-offline";
import type { AnnSearchResult, AnnHit } from "@/lib/brain-ann";
import { cacheRagResult as _cacheRagResult } from "@/lib/rag-offline";
import {
  clearAllResources,
  __resetForTests,
} from "@/lib/offline-cache";
import { __resetBackfillForTests } from "@/lib/rag-offline-backfill";

type AnalyticsEvent = [string, Record<string, string | number | boolean>];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "Content-Type": "application/json" }),
  } as unknown as Response;
}

function makeHit(i: number): BrainQueryHit {
  return {
    chunk_id: `c-${i}`,
    document_id: `d-${i}`,
    document_filename: `doc-${i}.pdf`,
    document_kind: "pdf",
    chunk_idx: i,
    content: `full chunk body ${i}`,
    score: 1 - i * 0.1,
    source: "keyword",
    snippet: `snippet <b>match</b> ${i}`,
  };
}

beforeEach(async () => {
  __resetForTests();
  __resetBackfillForTests();
  await clearAllResources();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
});

afterEach(async () => {
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("queryBrainWithCache — online fresh", () => {
  it("calls /api/brain/query and caches full hits", async () => {
    const hits = [makeHit(0), makeHit(1)];
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "cat",
        hits,
        keyword_hits: 2,
        semantic_hits: 0,
        latency_ms: 42,
        tokens_used: 0,
        query_log_id: 101,
      }),
    );
    const events: AnalyticsEvent[] = [];

    const result = await queryBrainWithCache("cat", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(false);
    expect(result.hits).toHaveLength(2);
    expect(result.answer).toBe(hits[0].snippet);
    expect(result.sources).toHaveLength(2);
    expect(result.keyword_hits).toBe(2);
    expect(result.query_log_id).toBe(101);
    expect(events.some(([e]) => e === "rag.result_cached")).toBe(true);
  });
});

describe("queryBrainWithCache — offline + cached", () => {
  it("returns cached hits when offline", async () => {
    // Prime via the real wrapper so the extras sentinel shape is correct.
    const hits = [makeHit(5)];
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "test",
        hits,
        keyword_hits: 1,
        semantic_hits: 0,
        latency_ms: 17,
        tokens_used: 0,
        query_log_id: 7,
      }),
    );
    await queryBrainWithCache("test", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
    });

    const offlineFetcher = jest.fn();
    const events: AnalyticsEvent[] = [];
    const result = await queryBrainWithCache("test", {
      isOnline: () => false,
      fetcher: offlineFetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].chunk_id).toBe("c-5");
    expect(result.keyword_hits).toBe(1);
    expect(result.query_log_id).toBe(7);
    expect(offlineFetcher).not.toHaveBeenCalled();
    expect(events.some(([e]) => e === "rag.served_from_cache")).toBe(true);
  });
});

describe("queryBrainWithCache — offline + no cache", () => {
  it("throws RagOfflineMissError", async () => {
    const events: AnalyticsEvent[] = [];
    await expect(
      queryBrainWithCache("nothing", {
        isOnline: () => false,
        fetcher: jest.fn() as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      }),
    ).rejects.toBeInstanceOf(RagOfflineMissError);
    expect(events.some(([e]) => e === "rag.cache_miss_offline")).toBe(true);
  });
});

describe("queryBrainWithCache — forceRefresh + fetch-throws", () => {
  it("forceRefresh fetches fresh even with cache", async () => {
    await _cacheRagResult("brain", {
      query: "x",
      retrieved_docs: [],
      answer: "stale",
      sources: [],
      scope: "brain",
    });
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ query: "x", hits: [makeHit(0)], keyword_hits: 1, semantic_hits: 0, latency_ms: 1, tokens_used: 0 }),
    );
    const result = await queryBrainWithCache("x", {
      isOnline: () => true,
      forceRefresh: true,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(false);
    expect(result.hits).toHaveLength(1);
  });

  it("falls through to cache on fetch error", async () => {
    const hits = [makeHit(3)];
    const seedFetcher = jest.fn().mockResolvedValue(
      jsonResponse({ query: "seed", hits, keyword_hits: 1, semantic_hits: 0, latency_ms: 2, tokens_used: 0 }),
    );
    await queryBrainWithCache("seed", {
      isOnline: () => true,
      fetcher: seedFetcher as unknown as typeof fetch,
    });
    const failing = jest.fn().mockRejectedValue(new Error("down"));
    const result = await queryBrainWithCache("seed", {
      isOnline: () => true,
      fetcher: failing as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(true);
    expect(result.hits[0].chunk_id).toBe("c-3");
  });
});

describe("queryBrainWithCache — Level-2 pack integration", () => {
  function makeAnnHit(i: number, doc_id?: string): AnnHit {
    return {
      chunk_id: `ann-c-${i}`,
      document_id: doc_id ?? `ann-doc-${i}`,
      document_filename: `ann-doc-${i}.pdf`,
      document_kind: "other",
      chunk_idx: i,
      content: `level-2 chunk body ${i}`,
      score: 1 - i * 0.1,
      source: i === 0 ? "keyword+semantic" : "semantic",
      snippet: `level-2 snippet ${i}`,
    };
  }
  function makeAnnResult(n: number): AnnSearchResult {
    return {
      query: "L2",
      hits: Array.from({ length: n }, (_, i) => makeAnnHit(i)),
      keyword_hits: n,
      semantic_hits: n,
      latency_ms: 7,
    };
  }

  it("offline + pack present → returns L2 hits with from_pack=true", async () => {
    const events: AnalyticsEvent[] = [];
    const getPackStats = jest
      .fn()
      .mockResolvedValue({ chunk_count: 128 });
    const annSearch = jest
      .fn()
      .mockResolvedValue(makeAnnResult(2));
    const fetcher = jest.fn(); // must NOT be called offline

    const result = await queryBrainWithCache("l2 query", {
      isOnline: () => false,
      fetcher: fetcher as unknown as typeof fetch,
      workspace: "ws-1",
      getPackStats,
      annSearch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(true);
    expect(result.from_pack).toBe(true);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].chunk_id).toBe("ann-c-0");
    expect(getPackStats).toHaveBeenCalledWith("ws-1");
    expect(annSearch).toHaveBeenCalledWith("l2 query", "ws-1", 10);
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.some(([e]) => e === "rag.served_from_pack")).toBe(true);
  });

  it("online → L2 path NOT taken (fresh fetch instead)", async () => {
    const hits = [makeHit(0)];
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "online",
        hits,
        keyword_hits: 1,
        semantic_hits: 0,
        latency_ms: 2,
        tokens_used: 0,
      }),
    );
    const annSearch = jest.fn();
    const getPackStats = jest.fn();

    const result = await queryBrainWithCache("online", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
      getPackStats,
      annSearch,
    });

    expect(result.from_cache).toBe(false);
    expect(result.from_pack).toBeUndefined();
    expect(annSearch).not.toHaveBeenCalled();
    expect(getPackStats).not.toHaveBeenCalled();
  });

  it("offline + empty pack → falls through to L1 fingerprint path", async () => {
    // Seed L1.
    const seedHits = [makeHit(9)];
    const seedFetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "fallthrough",
        hits: seedHits,
        keyword_hits: 1,
        semantic_hits: 0,
        latency_ms: 3,
        tokens_used: 0,
      }),
    );
    await queryBrainWithCache("fallthrough", {
      isOnline: () => true,
      fetcher: seedFetcher as unknown as typeof fetch,
    });

    const annSearch = jest.fn();
    const getPackStats = jest
      .fn()
      .mockResolvedValue({ chunk_count: 0 });

    const result = await queryBrainWithCache("fallthrough", {
      isOnline: () => false,
      fetcher: jest.fn() as unknown as typeof fetch,
      getPackStats,
      annSearch,
    });

    expect(result.from_cache).toBe(true);
    expect(result.from_pack).toBeUndefined();
    expect(result.hits[0].chunk_id).toBe("c-9");
    expect(annSearch).not.toHaveBeenCalled();
  });

  it("offline + L2 throws → falls through to L1", async () => {
    const seedHits = [makeHit(4)];
    const seedFetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "l2throws",
        hits: seedHits,
        keyword_hits: 1,
        semantic_hits: 0,
        latency_ms: 1,
        tokens_used: 0,
      }),
    );
    await queryBrainWithCache("l2throws", {
      isOnline: () => true,
      fetcher: seedFetcher as unknown as typeof fetch,
    });

    const getPackStats = jest
      .fn()
      .mockResolvedValue({ chunk_count: 17 });
    const annSearch = jest.fn().mockRejectedValue(new Error("ann-boom"));

    const result = await queryBrainWithCache("l2throws", {
      isOnline: () => false,
      fetcher: jest.fn() as unknown as typeof fetch,
      getPackStats,
      annSearch,
    });

    expect(result.from_cache).toBe(true);
    expect(result.from_pack).toBeUndefined();
    expect(result.hits[0].chunk_id).toBe("c-4");
  });

  it("offline + L2 returns empty hits → falls through to L1", async () => {
    const seedHits = [makeHit(2)];
    const seedFetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "empty-ann",
        hits: seedHits,
        keyword_hits: 1,
        semantic_hits: 0,
        latency_ms: 1,
        tokens_used: 0,
      }),
    );
    await queryBrainWithCache("empty-ann", {
      isOnline: () => true,
      fetcher: seedFetcher as unknown as typeof fetch,
    });

    const getPackStats = jest
      .fn()
      .mockResolvedValue({ chunk_count: 10 });
    const annSearch = jest.fn().mockResolvedValue({
      query: "empty-ann",
      hits: [],
      keyword_hits: 0,
      semantic_hits: 0,
      latency_ms: 1,
    } satisfies AnnSearchResult);

    const result = await queryBrainWithCache("empty-ann", {
      isOnline: () => false,
      fetcher: jest.fn() as unknown as typeof fetch,
      getPackStats,
      annSearch,
    });

    expect(result.from_cache).toBe(true);
    expect(result.from_pack).toBeUndefined();
    expect(result.hits[0].chunk_id).toBe("c-2");
  });

  it("L2 served result is cached at L1 for future fuzzy matches", async () => {
    const getPackStats = jest
      .fn()
      .mockResolvedValue({ chunk_count: 5 });
    const annSearch = jest
      .fn()
      .mockResolvedValue(makeAnnResult(1));

    // First offline call → L2 serves + caches.
    const r1 = await queryBrainWithCache("cacheable question", {
      isOnline: () => false,
      fetcher: jest.fn() as unknown as typeof fetch,
      getPackStats,
      annSearch,
    });
    expect(r1.from_pack).toBe(true);

    // Second offline call with pack now empty — should still hit L1 cache.
    const getPackStats2 = jest
      .fn()
      .mockResolvedValue({ chunk_count: 0 });
    const annSearch2 = jest.fn();
    const r2 = await queryBrainWithCache("cacheable question", {
      isOnline: () => false,
      fetcher: jest.fn() as unknown as typeof fetch,
      getPackStats: getPackStats2,
      annSearch: annSearch2,
    });
    expect(r2.from_cache).toBe(true);
    expect(annSearch2).not.toHaveBeenCalled();
    expect(r2.hits[0].chunk_id).toBe("ann-c-0");
  });
});

describe("queryBrainWithCache — backfill integration", () => {
  it("schedules ambient doc-body backfill keyed on unique document_ids", async () => {
    // Two hits from the SAME document should yield ONE backfill
    // target — the wrapper dedups on document_id before scheduling.
    const hits = [
      { ...makeHit(0), document_id: "doc-A" },
      { ...makeHit(1), document_id: "doc-A" },
      { ...makeHit(2), document_id: "doc-B" },
    ];
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        query: "k",
        hits,
        keyword_hits: 3,
        semantic_hits: 0,
        latency_ms: 1,
        tokens_used: 0,
      }),
    );
    const events: AnalyticsEvent[] = [];
    await queryBrainWithCache("k", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    await new Promise((r) => setTimeout(r, 10));
    const scheduled = events.find(
      ([e]) => e === "rag.doc_backfill_scheduled",
    );
    expect(scheduled).toBeDefined();
    // 2 unique docs → source_count=2, top_k capped at 2 (<= 3).
    expect(scheduled![1].source_count).toBe(2);
    expect(scheduled![1].scope).toBe("brain");
  });
});
