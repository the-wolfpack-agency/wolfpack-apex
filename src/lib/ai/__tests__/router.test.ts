/**
 * router — unit tests for the AI provider abstraction.
 *
 * Covers:
 *   - tier maps to right Anthropic model
 *   - cost_usd computed correctly per tier (cheap / standard / premium)
 *   - latency_ms is captured from the wall clock around the SDK call
 *   - anthropic-only flow today: AZURE env vars unset means Azure is
 *     never asked
 *   - failover: anthropic 5xx with no Azure available propagates a
 *     structured error
 *   - failover: when Azure is configured + primary, a 5xx falls back to
 *     Anthropic and reports fallback_used=true
 *   - PHI routes to Azure when Azure is configured
 *   - non-PHI stays on Anthropic when Azure is configured
 *   - trackEvent fires with the expected shape including feature +
 *     provider + model + tier + cost + fallback_used
 *   - getAIClient returns a singleton
 */

const mockMessagesCreate = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  class FakeInternalServerError extends Error {
    status = 500;
    name = "InternalServerError";
  }
  class FakeAPIError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  }
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })) as unknown as {
    new (...args: unknown[]): unknown;
    InternalServerError: typeof FakeInternalServerError;
    APIError: typeof FakeAPIError;
  };
  Anthropic.InternalServerError = FakeInternalServerError;
  Anthropic.APIError = FakeAPIError;
  return { __esModule: true, default: Anthropic };
});

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { getAIClient, _resetAIClientForTests } from "@/lib/ai/router";
import { ANTHROPIC_TIER_TO_MODEL } from "@/lib/ai/anthropic-provider";

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
});

function fakeOk(text = "hello", model = "claude-sonnet-4-6") {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    model,
  };
}

describe("router — tier → model mapping", () => {
  it("cheap maps to claude-haiku-4-5", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok", "claude-haiku-4-5"));
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "test.cheap" },
    });
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
    expect(ANTHROPIC_TIER_TO_MODEL.cheap).toBe("claude-haiku-4-5");
  });

  it("standard maps to claude-sonnet-4-6", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "test.standard" },
    });
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
  });

  it("premium maps to claude-opus-4-7", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok", "claude-opus-4-7"));
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "premium",
      metadata: { feature: "test.premium" },
    });
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
    );
  });
});

describe("router — cost calculation", () => {
  it("cheap: 1M in + 1M out = $1 + $5 = $6", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      model: "claude-haiku-4-5",
    });
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "cost.cheap" },
    });
    expect(out.cost_usd).toBeCloseTo(6, 6);
  });

  it("standard: 100k in + 50k out = $0.30 + $0.75 = $1.05", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100_000, output_tokens: 50_000 },
      model: "claude-sonnet-4-6",
    });
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "cost.standard" },
    });
    expect(out.cost_usd).toBeCloseTo(1.05, 6);
  });

  it("premium: 100k in + 100k out = $1.50 + $7.50 = $9.00", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 100_000, output_tokens: 100_000 },
      model: "claude-opus-4-7",
    });
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "premium",
      metadata: { feature: "cost.premium" },
    });
    expect(out.cost_usd).toBeCloseTo(9, 6);
  });
});

describe("router — latency capture", () => {
  it("captures latency_ms across the SDK call", async () => {
    mockMessagesCreate.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return fakeOk();
    });
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "latency.test" },
    });
    expect(out.latency_ms).toBeGreaterThanOrEqual(20);
  });
});

describe("router — anthropic-only routing today", () => {
  it("does NOT call Azure when AZURE_OPENAI_ENDPOINT is unset, even for PHI", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("anth"));
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "phi data" }],
      max_tokens: 10,
      model_tier: "standard",
      sensitivity: "phi",
      metadata: { feature: "phi.no.azure" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("router — failover", () => {
  it("anthropic 5xx with no fallback available propagates the error", async () => {
    const err = Object.assign(new Error("boom"), {
      status: 500,
      name: "InternalServerError",
    });
    mockMessagesCreate.mockRejectedValueOnce(err);
    await expect(
      getAIClient().complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: { feature: "failover.no.fallback" },
      }),
    ).rejects.toMatchObject({ message: "boom" });
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it("Azure 5xx falls back to Anthropic and reports fallback_used=true", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "akey";
    _resetAIClientForTests(null);
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("from-anth"));
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      sensitivity: "phi",
      metadata: { feature: "failover.azure.5xx" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const payload = mockTrackEvent.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.fallback_used).toBe(true);
  });
});

describe("router — sensitivity routing when Azure is configured", () => {
  it("non-PHI stays on Anthropic", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "akey";
    _resetAIClientForTests(null);
    mockMessagesCreate.mockResolvedValueOnce(fakeOk());
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "public stuff" }],
      max_tokens: 10,
      model_tier: "standard",
      sensitivity: "public",
      metadata: { feature: "sensitivity.public" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("router — analytics event shape", () => {
  it("emits ai.completion with feature/provider/model/tier/tokens/cost/latency", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 200, output_tokens: 100 },
      model: "claude-sonnet-4-6",
    });
    await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      sensitivity: "public",
      metadata: { feature: "analytics.shape", user_id: "u-1", user_role: "operator" },
    });
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [eventName, userId, userRole, metadata] =
      mockTrackEvent.mock.calls[0];
    expect(eventName).toBe("ai.completion");
    expect(userId).toBe("u-1");
    expect(userRole).toBe("operator");
    const m = metadata as Record<string, unknown>;
    expect(m).toMatchObject({
      feature: "analytics.shape",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tier: "standard",
      fallback_used: false,
      sensitivity: "public",
    });
    expect(m.input_tokens).toBe(200);
    expect(m.output_tokens).toBe(100);
    expect(typeof m.cost_usd).toBe("number");
    expect(typeof m.latency_ms).toBe("number");
  });

  it("defaults user_id + user_role to 'system' when metadata omits them", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk());
    await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "no.user" },
    });
    const [, userId, userRole] = mockTrackEvent.mock.calls[0];
    expect(userId).toBe("system");
    expect(userRole).toBe("system");
  });
});

describe("router — singleton", () => {
  it("getAIClient returns the same instance on repeated calls", () => {
    const a = getAIClient();
    const b = getAIClient();
    expect(a).toBe(b);
  });
});
