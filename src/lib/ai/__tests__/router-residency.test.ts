/**
 * The residency gate AT THE CHOKEPOINT: does a declared requirement actually
 * stop the call, and does an undeclared region actually count as a refusal?
 *
 * residency.test.ts proves the RULE. This proves the router obeys it, which is
 * the part that can silently stop being true: a gate that is computed and then
 * not acted on looks identical in code review to one that is enforced, and
 * identical in production right up until somebody asks for evidence.
 *
 * The assertion under every test is the same one: NOTHING WAS SENT. A refusal
 * that still dispatches is not a refusal, and asserting only on the thrown
 * error would pass in exactly that case.
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
import { ResidencyPolicyError } from "@/lib/ai/residency";

const REGION_VARS = ["AI_PROVIDER_REGION_ANTHROPIC", "AI_MODEL_REGION_ANTHROPIC"];

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
  for (const v of REGION_VARS) delete process.env[v];
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "claude-haiku-4-5",
  });
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  for (const v of REGION_VARS) delete process.env[v];
});

function request(residency?: string[]) {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    max_tokens: 10,
    model_tier: "cheap" as const,
    metadata: { feature: "test.residency", user_id: "u1", user_role: "cto" },
    ...(residency ? { residency } : {}),
  };
}

describe("router residency gate", () => {
  it("does nothing when the request declares no requirement", async () => {
    // An estate that has never thought about residency must be unaffected.
    await expect(getAIClient().complete(request())).resolves.toMatchObject({ content: "hello" });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("REFUSES, and sends nothing, when the model's region is undeclared", async () => {
    /* The case the module exists for. No region configured anywhere, and a
       request that says it may only be processed in the EU. */
    await expect(getAIClient().complete(request(["eu"]))).rejects.toThrow(ResidencyPolicyError);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("refuses, and sends nothing, when the model runs in the wrong region", async () => {
    process.env.AI_PROVIDER_REGION_ANTHROPIC = "us";
    await expect(getAIClient().complete(request(["eu"]))).rejects.toThrow(ResidencyPolicyError);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("allows the call when the model runs in a required region", async () => {
    process.env.AI_PROVIDER_REGION_ANTHROPIC = "eu";
    await expect(getAIClient().complete(request(["eu"]))).resolves.toMatchObject({ content: "hello" });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("allows when the model is in any one of several permitted regions", async () => {
    process.env.AI_PROVIDER_REGION_ANTHROPIC = "uk";
    await expect(getAIClient().complete(request(["eu", "uk"]))).resolves.toMatchObject({
      content: "hello",
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses with 422 and names both sides, so the refusal can be acted on", async () => {
    process.env.AI_PROVIDER_REGION_ANTHROPIC = "us";
    /* "Blocked" with no detail sends somebody digging through logs. The
       requirement and the actual region are the whole diagnosis. */
    const err = await getAIClient()
      .complete(request(["eu"]))
      .catch((e: unknown) => e as ResidencyPolicyError);
    expect(err).toBeInstanceOf(ResidencyPolicyError);
    expect((err as ResidencyPolicyError).status).toBe(422);
    expect((err as ResidencyPolicyError).details).toMatchObject({
      required: ["eu"],
      servedIn: "us",
      reason: "region_not_allowed",
    });
  });

  it("records the refusal, with the reason, so it is countable", async () => {
    process.env.AI_PROVIDER_REGION_ANTHROPIC = "us";
    await getAIClient().complete(request(["eu"])).catch(() => undefined);
    const blocked = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.request_blocked_residency");
    expect(blocked).toBeDefined();
    expect(blocked?.[3]).toMatchObject({
      required: "eu",
      served_in: "us",
      reason: "region_not_allowed",
      feature: "test.residency",
    });
  });

  it("distinguishes an undeclared region from a wrong one in the record", async () => {
    /* Two different fixes: one is "declare where this runs", the other is
       "provision a model over there". A single reason code for both would
       send somebody to the wrong one. */
    await getAIClient().complete(request(["eu"])).catch(() => undefined);
    const blocked = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.request_blocked_residency");
    expect(blocked?.[3]).toMatchObject({ reason: "region_undeclared", served_in: "unknown" });
  });

  it("emits no completion event for a refused request", async () => {
    // Nothing ran, so nothing may appear in spend or usage.
    process.env.AI_PROVIDER_REGION_ANTHROPIC = "us";
    await getAIClient().complete(request(["eu"])).catch(() => undefined);
    expect(mockTrackEvent.mock.calls.some((c) => c[0] === "ai.completion")).toBe(false);
  });

  it("treats an empty requirement list as no requirement, not as a lockout", async () => {
    /* A caller building the array from a config that happens to be empty must
       not take the whole estate down. */
    await expect(getAIClient().complete(request([]))).resolves.toMatchObject({ content: "hello" });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
