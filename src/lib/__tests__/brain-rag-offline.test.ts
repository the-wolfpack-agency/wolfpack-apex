/**
 * @jest-environment jsdom
 *
 * brain-rag-offline — wrapper contract tests.
 */

import "fake-indexeddb/auto";
import {
  queryBrainWithCache,
  RagOfflineMissError,
  type BrainQueryHit,
} from "@/lib/brain-rag-offline";
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
