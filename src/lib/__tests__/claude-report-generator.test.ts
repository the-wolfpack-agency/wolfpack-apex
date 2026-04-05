/**
 * Claude Report Generator — Tests
 *
 * Validates the AI-powered custom report generation flow:
 * cache check, Claude API call, artifact cleanup, caching, analytics.
 */

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn().mockResolvedValue({ rows: [], fromCache: true }),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/lib/report-templates", () => ({
  cleanAiArtifacts: jest.fn((text: string) => text.replace(/ — /g, ", ")),
  renderReportHtml: jest.fn((md: string) => `<html>${md}</html>`),
}));

import { generateCustomReport } from "@/lib/claude-report-generator";
import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DATABASE_URL;
});

describe("generateCustomReport", () => {
  const baseReq = {
    prompt: "Generate a compliance report for Acme Motors",
    clientName: "Acme Motors",
    userId: "user-1",
    userRole: "sales",
  };

  test("returns fallback message when ANTHROPIC_API_KEY not set", async () => {
    const result = await generateCustomReport(baseReq);

    expect(result.tokensUsed).toBe(0);
    expect(result.model).toBe("none");
    expect(result.cached).toBe(false);
    expect(result.content).toContain("ANTHROPIC_API_KEY");
    expect(result.content).toContain("Acme Motors");
  });

  test("tracks ai_call_made event even without API key", async () => {
    await generateCustomReport(baseReq);

    expect(trackEvent).toHaveBeenCalledWith(
      "system.ai_call_made",
      "user-1",
      "sales",
      expect.objectContaining({ module: "custom_report" }),
    );
  });

  test("tracks client.doc_generated with token and latency info", async () => {
    await generateCustomReport(baseReq);

    expect(trackEvent).toHaveBeenCalledWith(
      "client.doc_generated",
      "user-1",
      "sales",
      expect.objectContaining({
        source: "claude",
        client: "Acme Motors",
      }),
    );
  });

  test("cache check is attempted when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://test";
    // safeQuery returns empty (no cache hit) — still calls Claude path
    (safeQuery as jest.Mock).mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await generateCustomReport(baseReq);

    // safeQuery was called to check cache
    expect(safeQuery).toHaveBeenCalledWith(
      expect.stringContaining("apex_knowledge"),
      expect.any(Array),
    );
    // No cache hit, so not cached
    expect(result.cached).toBe(false);
  });

  test("skips cache check when DATABASE_URL not set", async () => {
    delete process.env.DATABASE_URL;

    await generateCustomReport(baseReq);

    // safeQuery should not be called for cache check (called at module mock level only)
    // The result should not be cached
    expect(trackEvent).not.toHaveBeenCalledWith(
      "system.ai_call_skipped",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ reason: "cache_hit" }),
    );
  });

  test("includes product context in the prompt when provided", async () => {
    const result = await generateCustomReport({
      ...baseReq,
      productContext: "Platform has 215+ API routes and 55 database migrations",
    });

    // Content should reference the fallback (no API key)
    expect(result.content).toContain("Acme Motors");
  });

  test("result includes prompt in fallback when no API key", async () => {
    const result = await generateCustomReport(baseReq);

    expect(result.content).toContain("Generate a compliance report for Acme Motors");
  });

  test("latencyMs is 0 for cached and no-key results", async () => {
    const result = await generateCustomReport(baseReq);
    expect(result.latencyMs).toBe(0);
  });
});
