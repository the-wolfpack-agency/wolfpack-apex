/**
 * @jest-environment jsdom
 *
 * rag-offline — tokenization + fingerprinting + cache round-trips +
 * Jaccard fuzzy match + scope isolation + oldest-first eviction +
 * analytics contract for rag.result_cached / rag.served_from_cache /
 * rag.cache_miss_offline / rag.cache_evicted.
 */

import "fake-indexeddb/auto";
import {
  STOPWORDS,
  fingerprintQuery,
  tokenizeQuery,
  jaccardSimilarity,
  cacheRagResult,
  findCachedRagResult,
  listCachedRagResults,
  evictOldRagResults,
  type CachedRagResult,
} from "@/lib/rag-offline";
import {
  clearAllResources,
  __resetForTests,
} from "@/lib/offline-cache";

type AnalyticsLog = Array<[string, Record<string, string | number | boolean>]>;

function mkAnalyticsLog(): {
  log: AnalyticsLog;
  onAnalytics: (e: string, m: Record<string, string | number | boolean>) => void;
} {
  const log: AnalyticsLog = [];
  return {
    log,
    onAnalytics: (e, m) => log.push([e, m]),
  };
}

beforeEach(async () => {
  __resetForTests();
  await clearAllResources();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
});

afterEach(async () => {
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stopword surface
// ---------------------------------------------------------------------------

describe("rag-offline — STOPWORDS surface", () => {
  it("exposes a stable, small stopword set", () => {
    expect(STOPWORDS.size).toBeGreaterThanOrEqual(30);
    expect(STOPWORDS.size).toBeLessThanOrEqual(60);
    // Spot-check a representative sample.
    for (const w of ["the", "a", "is", "are", "and", "or", "of", "what", "how", "why"]) {
      expect(STOPWORDS.has(w)).toBe(true);
    }
  });

  it("keeps meaningful content words out of the stopword list", () => {
    for (const w of ["plan", "monday", "revenue", "pipeline", "deploy"]) {
      expect(STOPWORDS.has(w)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tokenization + fingerprinting
// ---------------------------------------------------------------------------

describe("rag-offline — tokenizeQuery", () => {
  it("lowercases, splits, and drops stopwords", () => {
    expect(tokenizeQuery("What is the plan")).toEqual(["plan"]);
  });

  it("collapses whitespace + punctuation", () => {
    expect(tokenizeQuery("  Hello,   World!  ")).toEqual(["hello", "world"]);
  });

  it("returns [] for empty input", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });

  it("returns [] for all-stopword input", () => {
    expect(tokenizeQuery("what is the of to")).toEqual([]);
  });

  it("dedupes tokens while preserving first-seen order", () => {
    expect(tokenizeQuery("plan plan monday plan")).toEqual(["plan", "monday"]);
  });

  it("ignores non-string input defensively", () => {
    expect(tokenizeQuery(null as unknown as string)).toEqual([]);
    expect(tokenizeQuery(undefined as unknown as string)).toEqual([]);
  });
});

describe("rag-offline — fingerprintQuery", () => {
  it("is stable across whitespace + case variation", () => {
    const a = fingerprintQuery("  Hello, World! ");
    const b = fingerprintQuery("hello world");
    const c = fingerprintQuery("HELLO\tworld");
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe("hello world");
  });

  it("produces the same fingerprint for stopword variation", () => {
    expect(fingerprintQuery("the plan for monday"))
      .toBe(fingerprintQuery("plan for monday"));
  });
});

// ---------------------------------------------------------------------------
// Jaccard
// ---------------------------------------------------------------------------

describe("rag-offline — jaccardSimilarity", () => {
  it("is 1 for identical token sets", () => {
    expect(jaccardSimilarity(["plan", "monday"], ["plan", "monday"])).toBe(1);
  });

  it("is 0 for disjoint token sets", () => {
    expect(jaccardSimilarity(["plan"], ["revenue"])).toBe(0);
  });

  it("computes |A∩B|/|A∪B| correctly on partial overlap", () => {
    // {plan, monday} vs {plan, monday, urgent} -> 2/3
    const sim = jaccardSimilarity(
      ["plan", "monday"],
      ["plan", "monday", "urgent"],
    );
    expect(sim).toBeCloseTo(2 / 3, 5);
  });

  it("treats two empty sets as identical (1)", () => {
    expect(jaccardSimilarity([], [])).toBe(1);
  });

  it("treats empty vs non-empty as disjoint (0)", () => {
    expect(jaccardSimilarity([], ["plan"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip cache + exact lookup
// ---------------------------------------------------------------------------

describe("rag-offline — cache + exact findCachedRagResult round-trip", () => {
  it("caches a result and returns an exact hit on the same query", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    await cacheRagResult(
      "assistant",
      {
        query: "plan for monday",
        answer: "Review Q2 OKRs.",
        retrieved_docs: [{ doc: "okr-q2" }],
        sources: [{ id: "okr-q2", title: "Q2 OKRs" }],
        scope: "assistant",
      },
      { onAnalytics },
    );

    const hit = await findCachedRagResult("assistant", "Plan for Monday!", {
      onAnalytics,
    });
    expect(hit).not.toBeNull();
    expect(hit!.isFuzzy).toBe(false);
    expect(hit!.similarity).toBe(1);
    expect(hit!.entry.answer).toBe("Review Q2 OKRs.");
    expect(hit!.entry.query_fingerprint).toBe("plan monday");
    expect(hit!.entry.query_tokens).toEqual(["plan", "monday"]);
    expect(hit!.entry.sources).toEqual([{ id: "okr-q2", title: "Q2 OKRs" }]);

    // Analytics: exactly one result_cached + one served_from_cache (exact).
    const cachedEvents = log.filter(([e]) => e === "rag.result_cached");
    const servedEvents = log.filter(([e]) => e === "rag.served_from_cache");
    expect(cachedEvents).toHaveLength(1);
    expect(cachedEvents[0][1]).toEqual({
      scope: "assistant",
      query_token_count: 2,
      doc_count: 1,
    });
    expect(servedEvents).toHaveLength(1);
    expect(servedEvents[0][1].is_fuzzy).toBe(false);
    expect(servedEvents[0][1].similarity).toBe(1);
    expect(servedEvents[0][1].scope).toBe("assistant");
  });

  it("overwrites the same fingerprint on repeat cache", async () => {
    await cacheRagResult("assistant", {
      query: "plan for monday",
      answer: "v1",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    await cacheRagResult("assistant", {
      query: "plan for monday",
      answer: "v2",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    const hit = await findCachedRagResult("assistant", "plan for monday", {
      silentOnMiss: true,
    });
    expect(hit!.entry.answer).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// Fuzzy lookup
// ---------------------------------------------------------------------------

describe("rag-offline — fuzzy Jaccard lookup", () => {
  it("matches a near-identical phrasing above 0.7 threshold", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    // Cached: "plan for monday" -> tokens ["plan", "monday"]
    await cacheRagResult(
      "assistant",
      {
        query: "plan for monday",
        answer: "Review Q2 OKRs.",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { onAnalytics },
    );

    // Query: "what's the plan for monday" -> tokens ["plan", "monday"]
    // (what/the/for are stopwords). Should be an EXACT match on
    // fingerprint since tokens collapse identically.
    const hit = await findCachedRagResult(
      "assistant",
      "what's the plan for monday",
      { onAnalytics },
    );
    expect(hit).not.toBeNull();
    expect(hit!.entry.answer).toBe("Review Q2 OKRs.");
  });

  it("fuzzy-matches a non-identical-but-similar query via Jaccard", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    // Tokens: ["plan", "monday", "morning"]
    await cacheRagResult(
      "assistant",
      {
        query: "plan for monday morning",
        answer: "Morning plan answer.",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { onAnalytics },
    );

    // Tokens: ["plan", "monday"]. Jaccard = 2/3 ≈ 0.667 — below 0.7 default.
    const missAtDefault = await findCachedRagResult(
      "assistant",
      "plan for monday",
      { exactOnly: false, onAnalytics, silentOnMiss: true },
    );
    expect(missAtDefault).toBeNull();

    // Lowering the threshold should catch it.
    const hit = await findCachedRagResult("assistant", "plan for monday", {
      exactOnly: false,
      minSimilarity: 0.6,
      onAnalytics,
    });
    expect(hit).not.toBeNull();
    expect(hit!.isFuzzy).toBe(true);
    expect(hit!.similarity).toBeCloseTo(2 / 3, 3);
    expect(hit!.entry.answer).toBe("Morning plan answer.");

    const fuzzyServedEvents = log.filter(
      ([e, m]) => e === "rag.served_from_cache" && m.is_fuzzy === true,
    );
    expect(fuzzyServedEvents).toHaveLength(1);
  });

  it("picks the best-scoring candidate when multiple clear the threshold", async () => {
    // Two cached entries, one closer than the other.
    await cacheRagResult("assistant", {
      query: "plan monday morning standup",
      answer: "LESS_SIMILAR",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    await cacheRagResult("assistant", {
      query: "plan monday morning",
      answer: "MORE_SIMILAR",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    // Query tokens: ["plan", "monday", "morning"]
    // Against ["plan","monday","morning","standup"] -> 3/4 = 0.75
    // Against ["plan","monday","morning"]           -> 3/3 = 1.0 (exact)
    const hit = await findCachedRagResult(
      "assistant",
      "plan monday morning",
      { silentOnMiss: true },
    );
    expect(hit!.entry.answer).toBe("MORE_SIMILAR");
  });

  it("rejects completely different queries regardless of threshold", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    await cacheRagResult(
      "assistant",
      {
        query: "plan for monday",
        answer: "A",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { onAnalytics },
    );
    const hit = await findCachedRagResult(
      "assistant",
      "quarterly revenue breakdown by region",
      { onAnalytics, isOffline: true },
    );
    expect(hit).toBeNull();
    const missEvents = log.filter(([e]) => e === "rag.cache_miss_offline");
    expect(missEvents).toHaveLength(1);
    expect(missEvents[0][1]).toEqual({ scope: "assistant" });
  });

  it("exactOnly: true skips fuzzy lookup entirely", async () => {
    await cacheRagResult("assistant", {
      query: "plan for monday morning",
      answer: "A",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    const hit = await findCachedRagResult("assistant", "plan for monday", {
      exactOnly: true,
      minSimilarity: 0.1,
      silentOnMiss: true,
    });
    expect(hit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe("rag-offline — scope isolation", () => {
  it("does not leak assistant cache into knowledge scope lookup", async () => {
    await cacheRagResult("assistant", {
      query: "plan for monday",
      answer: "assistant-answer",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    const missInKnowledge = await findCachedRagResult(
      "knowledge",
      "plan for monday",
      { silentOnMiss: true },
    );
    expect(missInKnowledge).toBeNull();

    const hitInAssistant = await findCachedRagResult(
      "assistant",
      "plan for monday",
      { silentOnMiss: true },
    );
    expect(hitInAssistant!.entry.answer).toBe("assistant-answer");
  });

  it("listCachedRagResults returns only the requested scope", async () => {
    await cacheRagResult("assistant", {
      query: "alpha",
      answer: "A",
      retrieved_docs: [],
      sources: [],
      scope: "assistant",
    });
    await cacheRagResult("knowledge", {
      query: "beta",
      answer: "B",
      retrieved_docs: [],
      sources: [],
      scope: "knowledge",
    });

    const assistant = await listCachedRagResults("assistant");
    const knowledge = await listCachedRagResults("knowledge");
    expect(assistant).toHaveLength(1);
    expect(knowledge).toHaveLength(1);
    expect(assistant[0].answer).toBe("A");
    expect(knowledge[0].answer).toBe("B");
  });

  it("listCachedRagResults honors the limit parameter", async () => {
    await cacheRagResult("brain", {
      query: "alpha",
      answer: "A",
      retrieved_docs: [],
      sources: [],
      scope: "brain",
    });
    await cacheRagResult("brain", {
      query: "beta",
      answer: "B",
      retrieved_docs: [],
      sources: [],
      scope: "brain",
    });
    const limited = await listCachedRagResults("brain", 1);
    expect(limited).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

describe("rag-offline — per-scope cap eviction (oldest-first)", () => {
  it("drops oldest entries when the cap is exceeded", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    const t0 = 10_000_000;
    const nowSpy = jest.spyOn(Date, "now");

    // maxEntries=2, write 3 entries at distinct times.
    nowSpy.mockReturnValue(t0);
    await cacheRagResult(
      "assistant",
      {
        query: "one alpha",
        answer: "1",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { maxEntries: 2, onAnalytics },
    );
    nowSpy.mockReturnValue(t0 + 1000);
    await cacheRagResult(
      "assistant",
      {
        query: "two bravo",
        answer: "2",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { maxEntries: 2, onAnalytics },
    );
    nowSpy.mockReturnValue(t0 + 2000);
    await cacheRagResult(
      "assistant",
      {
        query: "three charlie",
        answer: "3",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { maxEntries: 2, onAnalytics },
    );

    const all = await listCachedRagResults("assistant");
    expect(all.map((e) => e.answer).sort()).toEqual(["2", "3"]);

    const evictEvents = log.filter(([e]) => e === "rag.cache_evicted");
    expect(evictEvents).toHaveLength(1);
    expect(evictEvents[0][1]).toEqual({ scope: "assistant", count: 1 });
  });

  it("maxEntries=0 disables the cap (no evictions)", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    await cacheRagResult(
      "assistant",
      {
        query: "one alpha",
        answer: "1",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { maxEntries: 0, onAnalytics },
    );
    await cacheRagResult(
      "assistant",
      {
        query: "two bravo",
        answer: "2",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { maxEntries: 0, onAnalytics },
    );
    const all = await listCachedRagResults("assistant");
    expect(all).toHaveLength(2);
    expect(log.some(([e]) => e === "rag.cache_evicted")).toBe(false);
  });
});

describe("rag-offline — evictOldRagResults (TTL)", () => {
  it("drops only entries older than maxAgeMs and returns the count", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    const t0 = 20_000_000;
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(t0);
    await cacheRagResult(
      "assistant",
      {
        query: "old one",
        answer: "O",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { onAnalytics },
    );
    nowSpy.mockReturnValue(t0 + 10_000);
    await cacheRagResult(
      "assistant",
      {
        query: "fresh two",
        answer: "F",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { onAnalytics },
    );

    // "Now" is 15s after t0 — older entry is 15s old, fresher is 5s.
    nowSpy.mockReturnValue(t0 + 15_000);
    const evicted = await evictOldRagResults("assistant", 8_000, {
      onAnalytics,
    });
    expect(evicted).toBe(1);
    const remaining = await listCachedRagResults("assistant");
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as CachedRagResult<unknown>).answer).toBe("F");

    const evictEvents = log.filter(([e]) => e === "rag.cache_evicted");
    expect(evictEvents).toHaveLength(1);
    expect(evictEvents[0][1]).toEqual({ scope: "assistant", count: 1 });
  });

  it("returns 0 and fires nothing when no entries are stale", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    await cacheRagResult(
      "assistant",
      {
        query: "fresh",
        answer: "F",
        retrieved_docs: [],
        sources: [],
        scope: "assistant",
      },
      { onAnalytics },
    );
    const evicted = await evictOldRagResults(
      "assistant",
      60 * 60 * 1000,
      { onAnalytics },
    );
    expect(evicted).toBe(0);
    const evictEvents = log.filter(([e]) => e === "rag.cache_evicted");
    expect(evictEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cache_miss_offline gating
// ---------------------------------------------------------------------------

describe("rag-offline — cache_miss_offline analytics gating", () => {
  it("does NOT fire cache_miss_offline when isOffline is false / unset", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    const hit = await findCachedRagResult("assistant", "anything goes", {
      onAnalytics,
    });
    expect(hit).toBeNull();
    expect(log.some(([e]) => e === "rag.cache_miss_offline")).toBe(false);
  });

  it("fires cache_miss_offline exactly once when isOffline=true and fully missing", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    const hit = await findCachedRagResult("assistant", "anything goes", {
      onAnalytics,
      isOffline: true,
    });
    expect(hit).toBeNull();
    const missEvents = log.filter(([e]) => e === "rag.cache_miss_offline");
    expect(missEvents).toHaveLength(1);
    expect(missEvents[0][1]).toEqual({ scope: "assistant" });
  });

  it("silentOnMiss=true suppresses cache_miss_offline even when isOffline=true", async () => {
    const { log, onAnalytics } = mkAnalyticsLog();
    const hit = await findCachedRagResult("assistant", "anything goes", {
      onAnalytics,
      isOffline: true,
      silentOnMiss: true,
    });
    expect(hit).toBeNull();
    expect(log.some(([e]) => e === "rag.cache_miss_offline")).toBe(false);
  });
});
