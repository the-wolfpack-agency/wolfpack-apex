/**
 * /api/support/analytics — route unit tests.
 *
 * Mocks @/lib/auth/require-capability, @/lib/support/analytics-repo, and
 * @/lib/analytics so we can drive every branch without infrastructure.
 *
 * Verifies:
 *   - 401 path when auth fails
 *   - happy path returns full payload + fires support.analytics_viewed
 *   - default window when ?window not provided
 *   - invalid window string falls back to default
 *   - graceful degradation: a single repo throw populates `errors` and
 *     returns the empty default for THAT section while every other
 *     section still loads
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/analytics-repo", () => ({
  getSavingsSummary: jest.fn(),
  getSavingsByFeature: jest.fn(),
  getSavingsByProvider: jest.fn(),
  getTopCachedResponses: jest.fn(),
  getDailySavingsTrend: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const repo = jest.requireMock("@/lib/support/analytics-repo");
const { trackEvent } = jest.requireMock("@/lib/analytics");

const user = { id: "u-1", email: "op@x.com", role: "dev" };

function unauth() {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }) as unknown as Response,
  };
}

function authed() {
  return { ok: true, user, capabilities: new Set() };
}

function req(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer t" },
  });
}

const SUMMARY = {
  tokens_saved: 12345,
  ai_calls: 50,
  cache_hits: 30,
  cache_miss: 20,
  cache_hit_rate: 0.6,
  cost_saved_usd: 0.0046,
  time_saved_ms: 1200,
  period: { start: "2026-04-20T00:00:00Z", end: "2026-04-27T00:00:00Z" },
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.getSavingsSummary.mockResolvedValue(SUMMARY);
  repo.getSavingsByFeature.mockResolvedValue([
    {
      feature: "support.draft",
      cache_hits: 8,
      cache_miss: 2,
      tokens_saved: 5000,
      hit_rate: 0.8,
    },
  ]);
  repo.getSavingsByProvider.mockResolvedValue([
    { provider: "azure-openai", calls: 20, tokens: 4000, cost_usd: 0.1 },
    {
      provider: "cache",
      calls: 30,
      tokens: 12345,
      cost_usd: 0,
      tokens_saved: 12345,
      cost_saved_usd: 0.0046,
    },
  ]);
  repo.getTopCachedResponses.mockResolvedValue([
    {
      id: "c-1",
      feature: "support.draft",
      hit_count: 12,
      helpful_count: 10,
      unhelpful_count: 1,
      tokens_saved_estimate: 5000,
      model_used: "gpt-4o-mini",
      last_used_at: "2026-04-27T00:00:00Z",
      prompt_preview: "Cannot sign in",
    },
  ]);
  repo.getDailySavingsTrend.mockResolvedValue([
    { date: "2026-04-25", tokens_saved: 0, ai_calls: 0, cache_hits: 0 },
    { date: "2026-04-26", tokens_saved: 100, ai_calls: 5, cache_hits: 2 },
    { date: "2026-04-27", tokens_saved: 50, ai_calls: 3, cache_hits: 3 },
  ]);
});

describe("GET /api/support/analytics", () => {
  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { GET } = await import("../analytics/route");
    const res = await GET(req("http://t/api/support/analytics?window=7d"));
    expect(res.status).toBe(401);
    expect(repo.getSavingsSummary).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("happy path: returns full payload + fires support.analytics_viewed", async () => {
    requireCapability.mockResolvedValue(authed());
    const { GET } = await import("../analytics/route");
    const res = await GET(req("http://t/api/support/analytics?window=7d"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe("7d");
    expect(body.summary).toEqual(SUMMARY);
    expect(body.by_feature).toHaveLength(1);
    expect(body.by_provider).toHaveLength(2);
    expect(body.top_cached).toHaveLength(1);
    expect(body.daily_trend).toHaveLength(3);
    expect(body.errors).toEqual({});
    expect(trackEvent).toHaveBeenCalledWith(
      "support.analytics_viewed",
      "u-1",
      "dev",
      expect.objectContaining({ window: "7d", section_errors: 0 }),
    );
    /* daily_trend should request 7 days when window=7d. */
    expect(repo.getDailySavingsTrend).toHaveBeenCalledWith(7);
  });

  it("defaults window to 7d when ?window omitted", async () => {
    requireCapability.mockResolvedValue(authed());
    const { GET } = await import("../analytics/route");
    const res = await GET(req("http://t/api/support/analytics"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe("7d");
    expect(repo.getSavingsSummary).toHaveBeenCalledWith("7d");
  });

  it("invalid ?window value falls back to 7d default", async () => {
    requireCapability.mockResolvedValue(authed());
    const { GET } = await import("../analytics/route");
    const res = await GET(
      req("http://t/api/support/analytics?window=not-a-window"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe("7d");
  });

  it("graceful degradation: one section throws → errors field set, others still load", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getSavingsByFeature.mockRejectedValue(new Error("feature query down"));
    const { GET } = await import("../analytics/route");
    const res = await GET(req("http://t/api/support/analytics?window=30d"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe("30d");
    expect(body.summary).toEqual(SUMMARY);
    expect(body.by_feature).toEqual([]);
    expect(body.by_provider).toHaveLength(2);
    expect(body.top_cached).toHaveLength(1);
    expect(body.errors).toEqual({ by_feature: "feature query down" });
    /* daily_trend for 30d window asks for 30 days. */
    expect(repo.getDailySavingsTrend).toHaveBeenCalledWith(30);
    /* Event still fires with section_errors=1. */
    expect(trackEvent).toHaveBeenCalledWith(
      "support.analytics_viewed",
      "u-1",
      "dev",
      expect.objectContaining({ window: "30d", section_errors: 1 }),
    );
  });

  it("today window asks for 1-day daily_trend", async () => {
    requireCapability.mockResolvedValue(authed());
    const { GET } = await import("../analytics/route");
    const res = await GET(req("http://t/api/support/analytics?window=today"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe("today");
    expect(repo.getDailySavingsTrend).toHaveBeenCalledWith(1);
  });
});
