/**
 * POST /api/knowledge/ask contract tests.
 *
 * Pure-handler test: requireCapability + askWithCache + trackEvent are
 * mocked, the handler is imported directly, responses are inspected.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockAskWithCache = jest.fn();
jest.mock("@/lib/knowledge/qa-cache", () => {
  const actual = jest.requireActual("@/lib/knowledge/qa-cache") as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    askWithCache: (...args: unknown[]) => mockAskWithCache(...args),
  };
});

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/knowledge/ask/route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://test/api/knowledge/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function allow(role = "dev") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: "u1", email: "u@t", name: "U", role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function deny(status: 401 | 403, msg = "Unauthorized") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: msg }, { status }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/knowledge/ask", () => {
  it("401 when caller is unauthenticated", async () => {
    deny(401);
    const res = await POST(req({ question: "hi", surface: "knowledge" }));
    expect(res.status).toBe(401);
  });

  it("400 when question is missing", async () => {
    allow();
    const res = await POST(req({ surface: "knowledge" }));
    expect(res.status).toBe(400);
  });

  it("400 when question is empty whitespace", async () => {
    allow();
    const res = await POST(req({ question: "   ", surface: "knowledge" }));
    expect(res.status).toBe(400);
  });

  it("400 when surface is invalid", async () => {
    allow();
    const res = await POST(req({ question: "x", surface: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("200 with was_cache_hit=true on a cache hit", async () => {
    allow();
    mockAskWithCache.mockResolvedValueOnce({
      qa_id: "q1",
      answer: "cached answer text — long enough to clear the low-confidence gate",
      source: "human_curated",
      ai_model: null,
      ai_generated_at: null,
      was_cache_hit: true,
      similarity: 1,
      latency_ms: 5,
    });
    const res = await POST(req({ question: "hello", surface: "knowledge" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.was_cache_hit).toBe(true);
    expect(body.qa_id).toBe("q1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.qa_lookup",
      "u1",
      "dev",
      expect.objectContaining({ was_cache_hit: true }),
    );
    /* No qa_ai_generated event on a hit. */
    const aiEvent = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "knowledge.qa_ai_generated",
    );
    expect(aiEvent).toBeUndefined();
  });

  it("200 with was_cache_hit=false on a miss + qa_ai_generated event", async () => {
    allow();
    mockAskWithCache.mockResolvedValueOnce({
      qa_id: "q2",
      answer: "fresh AI answer that is definitely longer than forty characters today",
      source: "ai_generated",
      ai_model: "anthropic/claude-haiku-4.5",
      ai_generated_at: "2026-04-29T00:00:00Z",
      was_cache_hit: false,
      latency_ms: 100,
      prompt_tokens: 12,
      completion_tokens: 30,
    });
    const res = await POST(
      req({ question: "novel question", surface: "knowledge" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.was_cache_hit).toBe(false);
    expect(body.source).toBe("ai_generated");
    expect(body.ai_model).toBe("anthropic/claude-haiku-4.5");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.qa_ai_generated",
      "u1",
      "dev",
      expect.objectContaining({ ai_model: "anthropic/claude-haiku-4.5" }),
    );
  });

  it("emits assistant.support_query when surface=assistant_support", async () => {
    allow();
    mockAskWithCache.mockResolvedValueOnce({
      qa_id: "q3",
      answer: "support answer that is definitely longer than the forty character bar",
      source: "ai_generated",
      ai_model: "x/y",
      ai_generated_at: "2026-04-29T00:00:00Z",
      was_cache_hit: false,
      latency_ms: 50,
      prompt_tokens: 5,
      completion_tokens: 5,
    });
    const res = await POST(
      req({ question: "support question", surface: "assistant_support" }),
    );
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.support_query",
      "u1",
      "dev",
      expect.objectContaining({ qa_id: "q3", was_cache_hit: false }),
    );
  });

  it("503 when the LLM is not configured", async () => {
    allow();
    mockAskWithCache.mockRejectedValueOnce(
      new Error("ANTHROPIC_API_KEY not configured"),
    );
    const res = await POST(req({ question: "x", surface: "knowledge" }));
    expect(res.status).toBe(503);
  });

  it("flags low_confidence on short answers", async () => {
    allow();
    mockAskWithCache.mockResolvedValueOnce({
      qa_id: "q4",
      answer: "I don't know.",
      source: "ai_generated",
      ai_model: "x/y",
      ai_generated_at: "2026-04-29T00:00:00Z",
      was_cache_hit: false,
      latency_ms: 30,
    });
    const res = await POST(
      req({ question: "obscure", surface: "assistant_support" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.low_confidence).toBe(true);
  });
});
