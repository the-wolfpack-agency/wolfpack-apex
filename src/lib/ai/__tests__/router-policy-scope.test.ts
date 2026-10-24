/**
 * Customer-facing content rules apply to customer-facing features only.
 *
 * In October 2026 the customer-chat rule price_guarantee matched the word
 * "guarantee" in generated CODE and withheld 7,346 CI fixes. The fixer read
 * the withheld notice as an empty fix, escalated, and the watcher re-drove it
 * every ten minutes. These tests pin the scope: a code-generation feature is
 * never withheld by a customer-chat rule, and customer chat still is.
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
import { WITHHELD_NOTICE, contentPolicyAudience, rulesForFeature, BASELINE_RULES } from "@/lib/ai/policy";

/** Real generated code from the loop: a comment and an identifier that say "guarantee". */
const GENERATED_CODE = `// We guarantee the lowest price is never negative.\nexport const priceGuarantee = (p: number) => Math.max(0, p);`;
const CHAT_PROMISE = "We guarantee the lowest price anywhere.";

function reply(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-haiku-4-5" };
}

function request(feature: string) {
  return {
    messages: [{ role: "user" as const, content: "go" }],
    max_tokens: 50,
    model_tier: "cheap" as const,
    metadata: { feature, user_id: "u1", user_role: "cto" },
  };
}

const refusals = () => mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.policy_refused");

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
  delete process.env.AI_CONTENT_POLICY_PROFILE;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  _resetAIClientForTests(null);
});

describe("contentPolicyAudience", () => {
  it.each([
    "ai-code-ci-fix",
    "ai-code-pipeline-author",
    "ai-code-pipeline-author-files",
    "ai-code-pipeline-author-anchor",
    "ai-code-pipeline-repair-files",
    "ai-code-plan",
    "ai_code.judge",
    "ai_code.repair",
    "gate-ci-autofix",
    "ai-code-ci-fix.review",
  ])("%s is code", (f) => {
    expect(contentPolicyAudience(f)).toBe("code");
  });

  it.each(["brain.retrieval_relevance", "brain.query_expansion", "support.categorize", "agent_probe"])("%s is machine-read", (f) => {
    expect(contentPolicyAudience(f)).toBe("machine");
  });

  it.each(["assistant_chat", "assistant_chat.review", "gate.external_agent", "support.draft", "assistant.routine", "", "brand.new.feature"])(
    "%s is customer-facing (the default keeps the gate)",
    (f) => {
      expect(contentPolicyAudience(f)).toBe("customer_facing");
    },
  );

  it("a missing feature is customer-facing", () => {
    expect(contentPolicyAudience(undefined)).toBe("customer_facing");
    expect(contentPolicyAudience(null)).toBe("customer_facing");
  });

  it("rulesForFeature drops every rule for code and keeps them for chat", () => {
    expect(rulesForFeature("ai-code-ci-fix", BASELINE_RULES)).toEqual([]);
    expect(rulesForFeature("assistant_chat", BASELINE_RULES)).toBe(BASELINE_RULES);
  });
});

describe("router: the 10-08 case", () => {
  it("a code-generation feature is NEVER withheld by a customer-chat rule", async () => {
    mockMessagesCreate.mockResolvedValue(reply(GENERATED_CODE));
    for (const feature of ["ai-code-ci-fix", "ai-code-pipeline-author-files", "gate-ci-autofix"]) {
      const res = await getAIClient().complete(request(feature));
      expect(res.content).toBe(GENERATED_CODE);
    }
    expect(refusals()).toHaveLength(0);
  });

  it("customer chat still is", async () => {
    mockMessagesCreate.mockResolvedValue(reply(CHAT_PROMISE));
    const res = await getAIClient().complete(request("assistant_chat"));
    expect(res.content).toBe(WITHHELD_NOTICE);
    const [ev] = refusals();
    expect(ev[3].rules).toContain("price_guarantee");
    expect(ev[3].audience).toBe("customer_facing");
  });

  it("the external gate still is", async () => {
    mockMessagesCreate.mockResolvedValue(reply(CHAT_PROMISE));
    const res = await getAIClient().complete(request("gate.external_agent"));
    expect(res.content).toBe(WITHHELD_NOTICE);
  });
});
