/**
 * Conditional verification AT THE CHOKEPOINT.
 *
 * verification.test.ts proves the policy. This proves the router acts on it,
 * and more importantly that it does NOT act when it should not: the cost case
 * for this whole feature is that the ordinary request pays for exactly one
 * call. A router that quietly retries on every request has inverted the saving
 * it was built to produce, and would look identical in code review.
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

function reply(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "claude-haiku-4-5",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function request(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user" as const, content: "what is the invoice total?" }],
    max_tokens: 50,
    model_tier: "cheap" as const,
    metadata: { feature: "test.verify", user_id: "u1", user_role: "cto" },
    ...extra,
  };
}

describe("router verification — when it must NOT spend", () => {
  it("does not check at all unless the caller asked", async () => {
    /* Every existing call site must be unchanged in cost and behaviour. */
    mockMessagesCreate.mockResolvedValue(reply(""));
    await getAIClient().complete(request());
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent.mock.calls.some((c) => c[0] === "ai.answer_verified")).toBe(false);
  });

  it("pays for exactly one call when the cheap model did the job", async () => {
    // THE COST CASE. If this ever fails, the feature costs more than it saves.
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    const res = await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(res.content).toBe("The invoice total is $4,200.");
  });

  it("does not pay to overrule a refusal", async () => {
    /* A model declining is usually the system working. Escalating buys a
       larger model's willingness to do what the first one declined. */
    mockMessagesCreate.mockResolvedValue(reply("I'm sorry, I can't help with that."));
    await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("never escalates past the top tier", async () => {
    mockMessagesCreate.mockResolvedValue(reply(""));
    await getAIClient().complete(request({ verify: true, model_tier: "premium" }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("router verification — when it should", () => {
  it("retries once on a better model when the answer fell short", async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you with those figures shortly."))
      .mockResolvedValueOnce(reply("The invoice total is $4,200."));
    const res = await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(res.content).toBe("The invoice total is $4,200.");
    // Escalated UP, not sideways: the second call must use a better model.
    expect(mockMessagesCreate.mock.calls[1][0].model).not.toBe(
      mockMessagesCreate.mock.calls[0][0].model,
    );
  });

  it("retries ONCE, never in a loop, even if the retry is also poor", async () => {
    /* A loop here is an unbounded bill attached to one user action. */
    mockMessagesCreate.mockResolvedValue(reply("I'll get back to you shortly."));
    await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("keeps the first answer when the retry throws", async () => {
    // A verified answer beats the first one; the first one beats an error.
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you shortly."))
      .mockRejectedValueOnce(new Error("provider down"));
    const res = await getAIClient().complete(request({ verify: true }));
    expect(res.content).toBe("I'll get back to you shortly.");
  });
});

describe("router verification — what it records", () => {
  it("records the pass, not only the failures", async () => {
    /* "The cheap model was fine" is the finding that justifies routing cheap
       at all, and it is invisible if only failures are counted. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: true }));
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_verified");
    expect(ev?.[3]).toMatchObject({ sufficient: true, escalated: false, flags: "" });
  });

  it("records which rule fired, so the reason is countable", async () => {
    mockMessagesCreate.mockResolvedValue(reply("Dear [INSERT NAME], thanks."));
    await getAIClient().complete(request({ verify: true }));
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_verified");
    expect(ev?.[3]).toMatchObject({ sufficient: false, escalated: true });
    expect(String(ev?.[3].flags)).toContain("placeholder");
  });

  it("marks the escalated call so its spend is separable from the first", async () => {
    /* Without this the second call looks like ordinary traffic and the true
       cost of verification cannot be measured. */
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you shortly."))
      .mockResolvedValueOnce(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: true }));
    const completions = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.completion");
    expect(completions.some((c) => String(c[3].feature).endsWith(".escalated"))).toBe(true);
  });
});
