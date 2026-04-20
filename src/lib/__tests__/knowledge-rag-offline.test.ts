/**
 * @jest-environment jsdom
 *
 * knowledge-rag-offline — wrapper contract tests.
 * Covers the 6 canonical paths from the Stream U2 brief.
 */

import "fake-indexeddb/auto";
import {
  queryKnowledgeWithCache,
  RagOfflineMissError,
} from "@/lib/knowledge-rag-offline";
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

describe("queryKnowledgeWithCache — online fresh", () => {
  it("calls /api/knowledge and caches the answer", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        answer: {
          id: "k-1",
          question: "original q",
          answer: "cached knowledge body",
          source: "docs",
        },
        source: "cache",
        tokens_used: 0,
      }),
    );
    const events: AnalyticsEvent[] = [];

    const result = await queryKnowledgeWithCache("how do I X", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(false);
    expect(result.answer).toBe("cached knowledge body");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].id).toBe("k-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/knowledge",
      expect.objectContaining({ method: "POST" }),
    );
    expect(events.some(([e]) => e === "rag.result_cached")).toBe(true);
  });

  it("returns server_has_no_answer=true when server says answer=null", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ answer: null, source: "none", tokens_used: 0 }),
    );
    const result = await queryKnowledgeWithCache("unknown", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(false);
    expect(result.server_has_no_answer).toBe(true);
    expect(result.answer).toBe("");
  });
});

describe("queryKnowledgeWithCache — offline paths", () => {
  it("returns cached entry when offline with a match", async () => {
    await _cacheRagResult("knowledge", {
      query: "payroll schedule",
      retrieved_docs: [],
      answer: "Every other Friday",
      sources: [{ id: "k-99", title: "payroll schedule" }],
      scope: "knowledge",
    });
    const fetcher = jest.fn();
    const events: AnalyticsEvent[] = [];

    const result = await queryKnowledgeWithCache("payroll schedule", {
      isOnline: () => false,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(true);
    expect(result.answer).toBe("Every other Friday");
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.some(([e]) => e === "rag.served_from_cache")).toBe(true);
  });

  it("throws RagOfflineMissError when offline and no match", async () => {
    const events: AnalyticsEvent[] = [];
    await expect(
      queryKnowledgeWithCache("nothing cached", {
        isOnline: () => false,
        fetcher: jest.fn() as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      }),
    ).rejects.toBeInstanceOf(RagOfflineMissError);
    expect(events.some(([e]) => e === "rag.cache_miss_offline")).toBe(true);
  });
});

describe("queryKnowledgeWithCache — forceRefresh + fetch-throws", () => {
  it("forceRefresh skips cache and hits server", async () => {
    await _cacheRagResult("knowledge", {
      query: "x",
      retrieved_docs: [],
      answer: "stale",
      sources: [],
      scope: "knowledge",
    });
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        answer: {
          id: "k-new",
          question: "x",
          answer: "fresh",
          source: "docs",
        },
      }),
    );
    const result = await queryKnowledgeWithCache("x", {
      isOnline: () => true,
      forceRefresh: true,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(false);
    expect(result.answer).toBe("fresh");
  });

  it("falls through to cache when online fetch throws", async () => {
    await _cacheRagResult("knowledge", {
      query: "backup",
      retrieved_docs: [],
      answer: "from snapshot",
      sources: [],
      scope: "knowledge",
    });
    const fetcher = jest.fn().mockRejectedValue(new Error("boom"));
    const result = await queryKnowledgeWithCache("backup", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(true);
    expect(result.answer).toBe("from snapshot");
  });
});

describe("queryKnowledgeWithCache — backfill integration", () => {
  it("schedules ambient doc-body backfill after successful online cache", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        answer: {
          id: "k-42",
          question: "q",
          answer: "a",
          source: "docs",
        },
        source: "cache",
        tokens_used: 0,
      }),
    );
    const events: AnalyticsEvent[] = [];
    await queryKnowledgeWithCache("test query", {
      isOnline: () => true,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    // Microtask boundary for scheduleDocBodyBackfill.
    await new Promise((r) => setTimeout(r, 10));
    // Knowledge has no doc-body endpoint today — scheduled fires, then
    // skipped with reason=no_endpoint (see rag-offline-backfill.ts).
    expect(
      events.some(([e]) => e === "rag.doc_backfill_scheduled"),
    ).toBe(true);
    expect(
      events.some(
        ([e, m]) =>
          e === "rag.doc_backfill_skipped" && m.reason === "no_endpoint",
      ),
    ).toBe(true);
  });
});
