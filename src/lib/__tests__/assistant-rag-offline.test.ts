/**
 * @jest-environment jsdom
 *
 * assistant-rag-offline — covers the Stream U2 integration contract:
 *   1. Online fresh happy-path calls endpoint + caches.
 *   2. Offline + cached match returns { from_cache: true }.
 *   3. Offline + no cache throws RagOfflineMissError.
 *   4. forceRefresh fetches even when cache would hit.
 *   5. Online fetch throws → falls through to cache.
 *   6. Analytics events fired by U1 on every path (plumbed through).
 */

import "fake-indexeddb/auto";
import {
  queryAssistantWithCache,
  RagOfflineMissError,
} from "@/lib/assistant-rag-offline";
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

function onlineTrue(): boolean {
  return true;
}
function onlineFalse(): boolean {
  return false;
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

describe("queryAssistantWithCache — online fresh", () => {
  it("calls /api/assistant and returns from_cache=false", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        response: "Hello world",
        source: "ai",
        tokensUsed: 42,
        conversationId: "c-1",
        messageId: "m-1",
        sources: [{ id: "s1", title: "Doc A", score: 0.9 }],
      }),
    );
    const events: AnalyticsEvent[] = [];

    const result = await queryAssistantWithCache("what is life", {
      isOnline: onlineTrue,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(false);
    expect(result.answer).toBe("Hello world");
    expect(result.sources).toEqual([
      { id: "s1", title: "Doc A", score: 0.9 },
    ]);
    expect(result.message_id).toBe("m-1");
    expect(result.conversation_id).toBe("c-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/assistant",
      expect.objectContaining({ method: "POST" }),
    );
    // U1's cacheRagResult fires `rag.result_cached` when we plumb
    // onAnalytics through.
    expect(events.some(([e]) => e === "rag.result_cached")).toBe(true);
  });

  it("forwards conversationId / pageContext into POST body", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ response: "ok", source: "ai", tokensUsed: 0 }),
    );

    await queryAssistantWithCache("hey", {
      isOnline: onlineTrue,
      fetcher: fetcher as unknown as typeof fetch,
      conversationId: "c-42",
      pageContext: "dashboard",
    });

    const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(body.message).toBe("hey");
    expect(body.conversationId).toBe("c-42");
    expect(body.pageContext).toBe("dashboard");
  });
});

describe("queryAssistantWithCache — offline + cached", () => {
  it("returns cached answer with from_cache=true on exact match", async () => {
    await _cacheRagResult("assistant", {
      query: "plan of the day",
      retrieved_docs: [],
      answer: "Cached answer text",
      sources: [{ id: "x", title: "Cached Doc" }],
      scope: "assistant",
    });

    const fetcher = jest.fn(); // must NOT be called
    const events: AnalyticsEvent[] = [];

    const result = await queryAssistantWithCache("Plan Of The Day", {
      isOnline: onlineFalse,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.from_cache).toBe(true);
    expect(result.answer).toBe("Cached answer text");
    expect(result.is_fuzzy).toBe(false);
    expect(result.similarity).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.some(([e]) => e === "rag.served_from_cache")).toBe(true);
  });
});

describe("queryAssistantWithCache — offline + no cache", () => {
  it("throws RagOfflineMissError when offline and no match", async () => {
    const fetcher = jest.fn();
    const events: AnalyticsEvent[] = [];

    await expect(
      queryAssistantWithCache("totally new question", {
        isOnline: onlineFalse,
        fetcher: fetcher as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      }),
    ).rejects.toBeInstanceOf(RagOfflineMissError);

    expect(fetcher).not.toHaveBeenCalled();
    expect(events.some(([e]) => e === "rag.cache_miss_offline")).toBe(true);
  });
});

describe("queryAssistantWithCache — forceRefresh", () => {
  it("fetches fresh even when a cache entry exists", async () => {
    await _cacheRagResult("assistant", {
      query: "forced query",
      retrieved_docs: [],
      answer: "stale cached",
      sources: [],
      scope: "assistant",
    });

    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ response: "fresh", source: "ai", tokensUsed: 0 }),
    );

    const result = await queryAssistantWithCache("forced query", {
      isOnline: onlineTrue,
      forceRefresh: true,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(false);
    expect(result.answer).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("queryAssistantWithCache — online fetch throws", () => {
  it("falls through to cache when fetch rejects", async () => {
    await _cacheRagResult("assistant", {
      query: "fallback target",
      retrieved_docs: [],
      answer: "from cache",
      sources: [],
      scope: "assistant",
    });
    const fetcher = jest.fn().mockRejectedValue(new Error("network down"));

    const result = await queryAssistantWithCache("fallback target", {
      isOnline: onlineTrue,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.from_cache).toBe(true);
    expect(result.answer).toBe("from cache");
  });

  it("throws RagOfflineMissError when fetch throws and no cache", async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error("network down"));
    await expect(
      queryAssistantWithCache("nothing here", {
        isOnline: onlineTrue,
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(RagOfflineMissError);
  });
});

describe("queryAssistantWithCache — navigator.onLine integration", () => {
  it("respects navigator.onLine when isOnline is not provided", async () => {
    // Offline
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    const fetcher = jest.fn();
    await expect(
      queryAssistantWithCache("zzz", {
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(RagOfflineMissError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("queryAssistantWithCache — backfill integration", () => {
  it("schedules ambient doc-body backfill after successful online cache", async () => {
    // Reset so the "onLine" flag from the previous test doesn't leak.
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({
        response: "hi",
        source: "ai",
        tokensUsed: 0,
        sources: [{ id: "s1", title: "Doc A" }],
      }),
    );
    const events: AnalyticsEvent[] = [];
    await queryAssistantWithCache("hello", {
      isOnline: onlineTrue,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    // Wait a few microtasks — scheduleDocBodyBackfill fires on a
    // queueMicrotask boundary.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      events.some(([e]) => e === "rag.doc_backfill_scheduled"),
    ).toBe(true);
  });
});

