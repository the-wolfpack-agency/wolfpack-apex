/**
 * router — unit tests for the AI provider abstraction.
 *
 * Covers:
 *   - tier maps to right Anthropic model
 *   - cost_usd computed correctly per tier (cheap / standard / premium)
 *   - latency_ms is captured from the wall clock around the SDK call
 *   - anthropic-only flow when AZURE env vars unset: Azure is never asked
 *   - failover: anthropic 5xx with no Azure available propagates a
 *     structured error
 *   - failover: when Azure is configured + primary, a 5xx falls back to
 *     Anthropic and reports fallback_used=true
 *   - when Azure is configured, Azure is the primary for every request;
 *     Anthropic remains the failover
 *   - AI_PROVIDER_PRIMARY=anthropic forces Anthropic primary even when
 *     Azure is configured
 *   - both providers fail: error propagates, no analytics event
 *   - trackEvent fires with the expected shape including feature +
 *     provider + model + tier + cost + fallback_used
 *   - getAIClient returns a singleton
 */

const mockMessagesCreate = jest.fn();
const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

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

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_CHEAP;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_PREMIUM;
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
  global.fetch = originalFetch;
});

function azureOk(content = "ok-azure", model = "gpt-4o") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      model,
    }),
    text: async () => "",
  };
}

function azureFail(status: number, body = "boom") {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({ error: { message: body } }),
    text: async () => JSON.stringify({ error: { message: body } }),
  };
}

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
    // A realistically shaped Azure endpoint. "example.azure.com" is not one:
    // real resources live under <name>.openai.azure.com, and since the egress
    // allowlist was wired into the provider a fixture that does not look like a
    // real endpoint is correctly refused. Making the fixture realistic is the
    // fix; adding a test hostname to a production allowlist would not be.
    process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "akey";
    _resetAIClientForTests(null);
    mockFetch.mockResolvedValueOnce(azureFail(503, "azure down"));
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("from-anth"));
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      sensitivity: "phi",
      metadata: { feature: "failover.azure.5xx" },
    });
    expect(out.provider_used).toBe("anthropic");
    /* A completion now emits BOTH ai.completion and ai.model_selected, so
       assert the one this test is about by name rather than by total. */
    expect(mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.completion")).toHaveLength(1);
    const payload = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion")![3] as Record<string, unknown>;
    expect(payload.fallback_used).toBe(true);
  });

  it("both providers fail: throws and emits no analytics event", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "akey";
    _resetAIClientForTests(null);
    mockFetch.mockResolvedValueOnce(azureFail(503, "azure down"));
    mockMessagesCreate.mockRejectedValueOnce(
      Object.assign(new Error("anth-down"), {
        status: 500,
        name: "InternalServerError",
      }),
    );
    await expect(
      getAIClient().complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: { feature: "failover.both.fail" },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("anth-down") });
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("router — Azure as primary when configured", () => {
  it("Azure is primary for ALL traffic when AZURE env vars are set", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "akey";
    _resetAIClientForTests(null);
    mockFetch.mockResolvedValueOnce(azureOk("ok"));
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "public stuff" }],
      max_tokens: 10,
      model_tier: "standard",
      sensitivity: "public",
      metadata: { feature: "azure.primary.public" },
    });
    expect(out.provider_used).toBe("azure-openai");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("only Anthropic configured: Anthropic is primary, no fallback", async () => {
    // No AZURE env vars set in beforeEach; ANTHROPIC_API_KEY is set.
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("anth-only"));
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "anth.only" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("AI_PROVIDER_PRIMARY=anthropic forces Anthropic primary even when Azure configured", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "akey";
    process.env.AI_PROVIDER_PRIMARY = "anthropic";
    _resetAIClientForTests(null);
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("anth-pinned"));
    const out = await getAIClient().complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "override.anth" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
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
    /* A completion now emits BOTH ai.completion and ai.model_selected, so
       assert the one this test is about by name rather than by total. */
    expect(mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.completion")).toHaveLength(1);
    const [eventName, userId, userRole, metadata] =
      mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion")!;
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
    const [, userId, userRole] = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion")!;
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

/**
 * Routing decisions are RECORDED, and savings are measured against a real
 * counterfactual.
 *
 * /admin/ai-router is built entirely from ai.model_selected. Until 2026-08-04
 * only the agent task executor emitted it, so every other AI call in the
 * platform — the assistant above all — made a selection through the bridge and
 * threw it away. The page presented itself as the router's view while reporting
 * on a small slice of traffic.
 */
describe("router — records the decision it made", () => {
  function anthropicOk() {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      model: "claude-haiku-4-5",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
  }

  test("a completion emits ai.model_selected, attributed to the caller", async () => {
    anthropicOk();
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: {
        feature: "assistant_chat",
        user_id: "u1",
        user_role: "admin",
        workspace_id: "ws1",
        routing_reason: "trivial_turn",
      },
    });

    const selected = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.model_selected");
    expect(selected).toBeDefined();
    expect(selected![1]).toBe("u1");
    expect(selected![2]).toBe("admin");
    expect(selected![3]).toEqual(
      expect.objectContaining({
        feature: "assistant_chat",
        workspace_id: "ws1",
        requested_tier: "cheap",
        routing_reason: "trivial_turn",
        // Keeps these countable apart from the executor's own rows.
        source: "execution_router",
      }),
    );
  });

  test("the recorded decision carries the reason the page renders", async () => {
    anthropicOk();
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "f" },
    });
    const selected = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.model_selected");
    expect(selected![3]).toEqual(
      expect.objectContaining({ model_id: expect.any(String), reason: expect.any(String) }),
    );
  });

  test("exactly one selection is recorded per completion", async () => {
    anthropicOk();
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "f" },
    });
    const n = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.model_selected").length;
    expect(n).toBe(1);
  });

  test("a failed call records no selection — an unspent decision is not a cost", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("boom"));
    await expect(
      getAIClient().complete({
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        model_tier: "cheap",
        metadata: { feature: "f" },
      }),
    ).rejects.toThrow();
    expect(mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.model_selected")).toHaveLength(0);
  });
});

describe("router — savings are measured, not asserted", () => {
  beforeEach(() => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      model: "claude-haiku-4-5",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
  });

  test("a baseline_tier records what the OLD behaviour would have cost", async () => {
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "assistant_chat", baseline_tier: "standard" },
    });

    const completion = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion");
    const meta = completion![3];
    expect(meta.baseline_tier).toBe("standard");
    expect(typeof meta.baseline_model_id).toBe("string");
    expect(typeof meta.baseline_cost_usd).toBe("number");
    /* The whole point: savings is a subtraction over real rows, so a cheaper
       model cannot be confused with lower usage. */
    expect(meta.savings_usd).toBeCloseTo(meta.baseline_cost_usd - meta.routed_cost_usd, 10);
    /* Cheap can never cost more than standard. Equal is legitimate when the
       deployment exposes one model for both tiers. */
    expect(meta.baseline_cost_usd).toBeGreaterThanOrEqual(meta.routed_cost_usd);
  });

  test("routing at the baseline tier yields no phantom saving", async () => {
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "assistant_chat", baseline_tier: "standard" },
    });
    const meta = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion")![3];
    expect(meta.savings_usd).toBeCloseTo(0, 6);
  });

  test("call sites without a baseline are unchanged — no invented fields", async () => {
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "other_surface" },
    });
    const meta = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion")![3];
    expect(meta.baseline_cost_usd).toBeUndefined();
    expect(meta.savings_usd).toBeUndefined();
  });

  test("the routing reason rides on the completion too, so cost joins to cause", async () => {
    await getAIClient().complete({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "assistant_chat", routing_reason: "trivial_turn" },
    });
    const meta = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.completion")![3];
    expect(meta.routing_reason).toBe("trivial_turn");
  });
});
