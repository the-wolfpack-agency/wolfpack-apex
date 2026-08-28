/**
 * A tier that is named but does not exist.
 *
 * Observed on production 2026-08-28: an assistant turn escalated to the
 * premium tier, Azure answered "The API deployment for this resource does not
 * exist", no second provider was configured, and the answer was lost
 * entirely. The premium deployment name had been set 122 days earlier and
 * points at something that is no longer there.
 *
 * isRetryableError deliberately refuses to retry 4xx, and it is right to: a
 * malformed request fails identically on the second attempt. This 404 is
 * different. It says nothing about the request and everything about our
 * configuration, and routing around an unavailable model is the entire job of
 * that file.
 */
const mockMessagesCreate = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: class {
      messages = { create: (...a: unknown[]) => mockMessagesCreate(...a) };
    },
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { getAIClient, _resetAIClientForTests } from "@/lib/ai/router";

/** Azure answering the way it does when a deployment name is stale. */
function missingDeployment() {
  return Object.assign(
    new Error("Azure OpenAI 404: The API deployment for this resource does not exist."),
    { name: "AzureProviderError", status: 404 },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "claude-haiku-4-5",
  });
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

const request = (tier: "cheap" | "standard" | "premium") => ({
  messages: [{ role: "user" as const, content: "hi" }],
  max_tokens: 10,
  model_tier: tier,
  metadata: { feature: "test.missing_deployment", user_id: "u1", user_role: "cto" },
});

describe("when the requested tier has no deployment", () => {
  it("serves the answer from a cheaper tier rather than losing it", async () => {
    let calls = 0;
    mockMessagesCreate.mockImplementation(async () => {
      calls += 1;
      /* The first attempt is the requested tier and 404s; the second is the
         degraded one and succeeds. */
      if (calls === 1) throw missingDeployment();
      return {
        content: [{ type: "text", text: "answered anyway" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: "claude-haiku-4-5",
      };
    });

    const res = await getAIClient().complete(request("premium"));
    expect(res.content).toBe("answered anyway");
  });

  /* A silent degrade would hide the stale variable forever. The reason this
     bug survived 122 days is that nothing said the tier was broken. */
  it("records that it degraded, and which tiers were involved", async () => {
    let calls = 0;
    mockMessagesCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw missingDeployment();
      return {
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: "claude-haiku-4-5",
      };
    });

    await getAIClient().complete(request("premium"));

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ai.tier_degraded_missing_deployment",
      "u1",
      "cto",
      expect.objectContaining({ requested_tier: "premium", served_tier: "standard" }),
    );
  });

  /* At the bottom of the ladder there is nothing cheaper to try, and inventing
     a retry there would loop against the same missing deployment. */
  it("gives up honestly when the cheapest tier is the missing one", async () => {
    mockMessagesCreate.mockRejectedValue(missingDeployment());
    await expect(getAIClient().complete(request("cheap"))).rejects.toThrow(/does not exist/i);
  });
});

describe("what it must not swallow", () => {
  /* A 404 that is not about a deployment is somebody else's bug and should
     surface rather than be quietly retried at a cheaper tier. */
  it("does not degrade on an unrelated 404", async () => {
    mockMessagesCreate.mockRejectedValue(
      Object.assign(new Error("404: no such conversation"), { status: 404 }),
    );
    await expect(getAIClient().complete(request("premium"))).rejects.toThrow(/no such conversation/i);
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "ai.tier_degraded_missing_deployment",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  /* A malformed request fails identically at every tier, so degrading would
     spend a second call to reach the same answer. */
  it("does not degrade on a 400", async () => {
    mockMessagesCreate.mockRejectedValue(
      Object.assign(new Error("400: bad request"), { status: 400 }),
    );
    await expect(getAIClient().complete(request("premium"))).rejects.toThrow(/bad request/i);
  });
});
