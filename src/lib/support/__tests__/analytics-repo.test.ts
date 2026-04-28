/**
 * support / analytics-repo — unit tests.
 *
 * Mocks @/lib/db so we drive each aggregation function with synthetic
 * row sets. Verifies:
 *   - shape of returned summary / breakdowns / chart data
 *   - window parameter affects WHERE clause (today vs 7d vs 30d)
 *   - zero-state defaults: ai_calls=0 → cache_hit_rate=0 (not NaN)
 *   - cost_saved_usd math at cheap-tier rates
 *   - feature breakdown buckets correctly across mixed events
 *   - getDailySavingsTrend echoes one row per day in the input set
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  getSavingsSummary,
  getSavingsByFeature,
  getSavingsByProvider,
  getTopCachedResponses,
  getDailySavingsTrend,
  resolveWindow,
} from "@/lib/support/analytics-repo";

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// resolveWindow
// ---------------------------------------------------------------------------

describe("resolveWindow", () => {
  it("'all' returns null start", () => {
    const w = resolveWindow("all");
    expect(w.start).toBeNull();
    expect(typeof w.end).toBe("string");
  });

  it("'today' starts at UTC midnight today", () => {
    const w = resolveWindow("today");
    expect(w.start).not.toBeNull();
    const start = new Date(w.start as string);
    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCMinutes()).toBe(0);
    expect(start.getUTCSeconds()).toBe(0);
  });

  it("'7d' starts approximately 7 days before now", () => {
    const w = resolveWindow("7d");
    const start = new Date(w.start as string);
    const end = new Date(w.end);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(6.99);
    expect(diffDays).toBeLessThan(7.01);
  });

  it("'30d' starts approximately 30 days before now", () => {
    const w = resolveWindow("30d");
    const start = new Date(w.start as string);
    const end = new Date(w.end);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.99);
    expect(diffDays).toBeLessThan(30.01);
  });
});

// ---------------------------------------------------------------------------
// getSavingsSummary
// ---------------------------------------------------------------------------

describe("getSavingsSummary", () => {
  it("returns shape with cheap-tier cost math correct", async () => {
    /* tokens_saved query, then events count query, then latency query. */
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tokens_saved: 1_000_000 }] })
      .mockResolvedValueOnce({ rows: [{ ai_calls: 10, cache_hits: 4 }] })
      .mockResolvedValueOnce({ rows: [{ hit_avg: 30, miss_avg: 1500 }] });

    const out = await getSavingsSummary("7d");
    expect(out.tokens_saved).toBe(1_000_000);
    expect(out.ai_calls).toBe(10);
    expect(out.cache_hits).toBe(4);
    expect(out.cache_miss).toBe(6);
    expect(out.cache_hit_rate).toBeCloseTo(0.4);
    /* 1_000_000 tokens at blended cheap rate ((0.15+0.6)/2)/MTok = $0.375. */
    expect(out.cost_saved_usd).toBeCloseTo(0.375, 5);
    /* (1500 - 30) * 4 = 5880 ms. */
    expect(out.time_saved_ms).toBe(5880);
    expect(out.period.start).not.toBeNull();
    expect(out.period.end).not.toBeNull();
  });

  it("zero-state: 0 ai_calls returns 0 hit_rate (not NaN)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tokens_saved: 0 }] })
      .mockResolvedValueOnce({ rows: [{ ai_calls: 0, cache_hits: 0 }] })
      .mockResolvedValueOnce({ rows: [{ hit_avg: null, miss_avg: null }] });

    const out = await getSavingsSummary("today");
    expect(out.ai_calls).toBe(0);
    expect(out.cache_hits).toBe(0);
    expect(out.cache_miss).toBe(0);
    expect(out.cache_hit_rate).toBe(0);
    expect(Number.isFinite(out.cache_hit_rate)).toBe(true);
    expect(out.cost_saved_usd).toBe(0);
    expect(out.time_saved_ms).toBe(0);
  });

  it("'all' window passes no time bound to either SQL fragment", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tokens_saved: 0 }] })
      .mockResolvedValueOnce({ rows: [{ ai_calls: 0, cache_hits: 0 }] })
      .mockResolvedValueOnce({ rows: [{ hit_avg: null, miss_avg: null }] });

    await getSavingsSummary("all");
    /* Each call's params array should be empty for 'all'. */
    expect(mockQuery.mock.calls[0][1]).toEqual([]);
    expect(mockQuery.mock.calls[1][1]).toEqual([]);
    expect(mockQuery.mock.calls[2][1]).toEqual([]);
    /* And the SQL must NOT contain a >= bound. */
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/last_used_at >=/);
    expect(mockQuery.mock.calls[1][0]).not.toMatch(/timestamp >=/);
  });

  it("'today' / '7d' / '30d' each pass a single ISO timestamp param to each query", async () => {
    for (const w of ["today", "7d", "30d"] as const) {
      mockQuery.mockReset();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ tokens_saved: 0 }] })
        .mockResolvedValueOnce({ rows: [{ ai_calls: 0, cache_hits: 0 }] })
        .mockResolvedValueOnce({ rows: [{ hit_avg: null, miss_avg: null }] });
      await getSavingsSummary(w);
      const cacheParams = mockQuery.mock.calls[0][1] as unknown[];
      expect(cacheParams).toHaveLength(1);
      expect(typeof cacheParams[0]).toBe("string");
      expect(() => new Date(cacheParams[0] as string).toISOString()).not.toThrow();
      expect(mockQuery.mock.calls[0][0]).toMatch(/last_used_at >=/);
      expect(mockQuery.mock.calls[1][0]).toMatch(/timestamp >=/);
    }
  });

  it("falls back to hit-latency * cache_hits when miss latency unavailable", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tokens_saved: 0 }] })
      .mockResolvedValueOnce({ rows: [{ ai_calls: 5, cache_hits: 5 }] })
      .mockResolvedValueOnce({ rows: [{ hit_avg: 25, miss_avg: null }] });

    const out = await getSavingsSummary("7d");
    /* No misses to compare → fallback = 25ms * 5 hits = 125ms. */
    expect(out.time_saved_ms).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// getSavingsByFeature
// ---------------------------------------------------------------------------

describe("getSavingsByFeature", () => {
  it("buckets by feature and computes hit_rate correctly", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          feature: "support.draft",
          cache_hits: 8,
          cache_miss: 2,
          tokens_saved: 5000,
        },
        {
          feature: "support.categorize",
          cache_hits: 0,
          cache_miss: 4,
          tokens_saved: 0,
        },
      ],
    });
    const out = await getSavingsByFeature("7d");
    expect(out).toHaveLength(2);
    expect(out[0].feature).toBe("support.draft");
    expect(out[0].cache_hits).toBe(8);
    expect(out[0].cache_miss).toBe(2);
    expect(out[0].tokens_saved).toBe(5000);
    expect(out[0].hit_rate).toBeCloseTo(0.8);
    /* Zero hits + nonzero misses → hit_rate=0, never NaN. */
    expect(out[1].hit_rate).toBe(0);
    expect(Number.isFinite(out[1].hit_rate)).toBe(true);
  });

  it("zero-bucket → hit_rate=0 (not NaN)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          feature: "support.auto_ack",
          cache_hits: 0,
          cache_miss: 0,
          tokens_saved: 0,
        },
      ],
    });
    const out = await getSavingsByFeature("today");
    expect(out[0].hit_rate).toBe(0);
    expect(Number.isFinite(out[0].hit_rate)).toBe(true);
  });

  it("empty result → empty array", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getSavingsByFeature("all");
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getSavingsByProvider
// ---------------------------------------------------------------------------

describe("getSavingsByProvider", () => {
  it("real provider rows get cost_usd, cache row gets tokens_saved + cost_saved_usd", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          provider: "azure-openai",
          calls: 6,
          tokens: 1234,
          cost_usd: 0.07,
          tokens_saved: 0,
        },
        {
          provider: "cache",
          calls: 4,
          tokens: 0,
          cost_usd: 0,
          tokens_saved: 2_000_000,
        },
      ],
    });
    const out = await getSavingsByProvider("7d");
    expect(out).toHaveLength(2);
    const real = out.find((r) => r.provider === "azure-openai")!;
    expect(real.calls).toBe(6);
    expect(real.tokens).toBe(1234);
    expect(real.cost_usd).toBeCloseTo(0.07);
    expect(real.tokens_saved).toBeUndefined();
    expect(real.cost_saved_usd).toBeUndefined();

    const cache = out.find((r) => r.provider === "cache")!;
    expect(cache.calls).toBe(4);
    expect(cache.cost_usd).toBe(0);
    expect(cache.tokens).toBe(2_000_000);
    expect(cache.tokens_saved).toBe(2_000_000);
    /* 2M tokens * (0.15+0.6)/2 / 1M = $0.75 */
    expect(cache.cost_saved_usd).toBeCloseTo(0.75, 5);
  });
});

// ---------------------------------------------------------------------------
// getTopCachedResponses
// ---------------------------------------------------------------------------

describe("getTopCachedResponses", () => {
  it("uses prompt_input.title for prompt_preview when present", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "c-1",
          feature: "support.draft",
          hit_count: 12,
          helpful_count: 10,
          unhelpful_count: 1,
          tokens_saved_estimate: 50000,
          model_used: "gpt-4o-mini",
          last_used_at: "2026-04-27T00:00:00.000Z",
          prompt_input: { title: "Cannot sign in", body: "AADSTS50126 ..." },
        },
      ],
    });
    const out = await getTopCachedResponses("7d", 10);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("c-1");
    expect(out[0].prompt_preview).toBe("Cannot sign in");
    expect(out[0].hit_count).toBe(12);
    expect(out[0].helpful_count).toBe(10);
    expect(out[0].unhelpful_count).toBe(1);
  });

  it("falls back to body[:80] when title missing", async () => {
    const longBody = "x".repeat(200);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "c-2",
          feature: "support.categorize",
          hit_count: 1,
          helpful_count: 0,
          unhelpful_count: 0,
          tokens_saved_estimate: 100,
          model_used: "claude-haiku-4-5",
          last_used_at: null,
          prompt_input: { body: longBody },
        },
      ],
    });
    const out = await getTopCachedResponses("today");
    expect(out[0].prompt_preview.length).toBe(80);
    expect(out[0].prompt_preview).toBe("x".repeat(80));
    expect(out[0].last_used_at).toBeNull();
  });

  it("clamps limit to safe range", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopCachedResponses("7d", 9999);
    /* The SQL includes a LIMIT N; verify it was clamped to 100. */
    expect(mockQuery.mock.calls[0][0]).toMatch(/LIMIT 100/);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTopCachedResponses("7d", 0);
    expect(mockQuery.mock.calls[1][0]).toMatch(/LIMIT 1/);
  });
});

// ---------------------------------------------------------------------------
// getDailySavingsTrend
// ---------------------------------------------------------------------------

describe("getDailySavingsTrend", () => {
  it("returns a row per day from the underlying query", async () => {
    /* The SQL uses generate_series so this is the DB's job; we just
       check we map the rows through faithfully. */
    mockQuery.mockResolvedValueOnce({
      rows: [
        { date: "2026-04-25", tokens_saved: 0, ai_calls: 0, cache_hits: 0 },
        { date: "2026-04-26", tokens_saved: 100, ai_calls: 5, cache_hits: 2 },
        { date: "2026-04-27", tokens_saved: 50, ai_calls: 3, cache_hits: 3 },
      ],
    });
    const out = await getDailySavingsTrend(3);
    expect(out).toHaveLength(3);
    expect(out[0].date).toBe("2026-04-25");
    expect(out[0].tokens_saved).toBe(0);
    expect(out[0].ai_calls).toBe(0);
    expect(out[1].cache_hits).toBe(2);
    expect(out[2].tokens_saved).toBe(50);
  });

  it("clamps days to safe range and passes it as $1", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getDailySavingsTrend(99999);
    expect(mockQuery.mock.calls[0][1]).toEqual([365]);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getDailySavingsTrend(0);
    expect(mockQuery.mock.calls[1][1]).toEqual([1]);
  });
});
