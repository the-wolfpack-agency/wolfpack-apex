/**
 * The content policy AT THE CHOKEPOINT.
 *
 * policy.test.ts proves the rules. This proves the router acts on them, and,
 * with equal weight, that it does NOT act where acting would break something:
 *
 *   - an ordinary answer is returned byte-for-byte, so no existing call site
 *     changes shape or cost;
 *   - a withheld answer is a COMPLETED call, not an exception, because a
 *     caller handed an error has to write a failure path for a case that is
 *     not a failure;
 *   - the judge's verdict about an answer is not gated, or the gate would
 *     withhold the finding instead of the claim;
 *   - a policy pass that throws leaves the answer exactly as it was.
 */

const mockMessagesCreate = jest.fn();
const mockTrackEvent = jest.fn();
const mockLoadPolicy = jest.fn();

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

import {
  getAIClient,
  _resetAIClientForTests,
  _buildAIClientWithBudgetDepsForTests,
} from "@/lib/ai/router";
import { WITHHELD_NOTICE } from "@/lib/ai/policy";

/* The workspace row is the only DB fact this gate needs: which industry
   profile the tenant runs. Injected through the router's own seam rather than
   by setting DATABASE_URL, so no test here can reach a real Postgres. */
function clientWithWorkspace(row: Record<string, unknown> | null | Error) {
  return _buildAIClientWithBudgetDepsForTests({
    loadPolicy: async (id) => {
      mockLoadPolicy(id);
      if (row instanceof Error) throw row;
      return row as never;
    },
    monthSpend: async () => 0,
  });
}

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
  delete process.env.AI_CONTENT_POLICY_PROFILE;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_CONTENT_POLICY_PROFILE;
});

function request(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user" as const, content: "what rate can I get?" }],
    max_tokens: 50,
    model_tier: "cheap" as const,
    metadata: { feature: "test.policy", user_id: "u1", user_role: "cto" },
    ...extra,
  };
}

const refusals = () => mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.policy_refused");

describe("router content policy — leaving ordinary answers alone", () => {
  it("returns a clean answer unchanged and records no refusal", async () => {
    const text = "Your local Centre can walk you through the finance options available.";
    mockMessagesCreate.mockResolvedValue(reply(text));

    const res = await getAIClient().complete(request());

    expect(res.content).toBe(text);
    expect(refusals()).toHaveLength(0);
  });

  it("runs the baseline set when no workspace profile is configured", async () => {
    /* A workspace with no row is not a workspace with no policy. */
    mockMessagesCreate.mockResolvedValue(reply("We guarantee the lowest price anywhere."));

    const res = await getAIClient().complete(request());

    expect(res.content).toBe(WITHHELD_NOTICE);
    expect(refusals()[0][3].rules).toContain("price_guarantee");
  });

  it("does not apply an industry rule the tenant is not on", async () => {
    /* A quoted APR is an automotive rule. A baseline tenant keeps its answer,
       or every deployment would inherit another industry's constraints. */
    mockMessagesCreate.mockResolvedValue(reply("You'll qualify for 2.9% APR on that."));

    const res = await getAIClient().complete(request());

    expect(res.content).toContain("2.9% APR");
    expect(refusals()).toHaveLength(0);
  });
});

describe("router content policy — withholding", () => {
  it("replaces a blocked answer instead of throwing", async () => {
    /* THE SHAPE OF A REFUSAL. A caller that receives an exception must write a
       failure path for something that is not a failure; a caller that receives
       a short true sentence just renders it. */
    mockMessagesCreate.mockResolvedValue(reply("There are no open recalls, it's safe to drive."));
    process.env.AI_CONTENT_POLICY_PROFILE = "automotive";

    const res = await getAIClient().complete(request());

    expect(res.content).toBe(WITHHELD_NOTICE);
    expect(res.content).not.toContain("safe to drive");
    /* Still a completed call: it was paid for and it is counted. */
    expect(res.input_tokens).toBe(10);
    expect(mockTrackEvent.mock.calls.some((c) => c[0] === "ai.completion")).toBe(true);
  });

  it("records the rule, never the sentence", async () => {
    /* An event store that quotes blocked answers is a permanent, queryable
       archive of exactly the text the gate decided nobody should read. */
    process.env.AI_CONTENT_POLICY_PROFILE = "automotive";
    mockMessagesCreate.mockResolvedValue(reply("That repair is covered under your warranty, no charge."));

    await getAIClient().complete(request());

    const [, , , meta] = refusals()[0];
    expect(meta.rules).toBe("warranty_coverage");
    expect(meta.action).toBe("escalate");
    expect(meta.profile).toBe("automotive");
    expect(JSON.stringify(meta)).not.toContain("covered under your warranty");
  });

  it("takes the profile from the workspace row over the deployment default", async () => {
    process.env.AI_CONTENT_POLICY_PROFILE = "automotive";
    const client = clientWithWorkspace({
      workspace_id: "w1",
      max_tier: null,
      monthly_budget_usd: null,
      content_policy_profile: "retail",
    });
    mockMessagesCreate.mockResolvedValue(reply("Use code SAVE20 at checkout."));

    const res = await client.complete(
      request({ metadata: { feature: "t", user_id: "u1", user_role: "cto", workspace_id: "w1" } }),
    );

    /* An automotive deployment hosting a retail tenant applies the RETAIL set:
       the discount is refused and the tenant is not held to car rules. */
    expect(res.content).toBe(WITHHELD_NOTICE);
    expect(refusals()[0][3].profile).toBe("retail");
  });

  it("reads the workspace row ONCE for both the budget and the policy", async () => {
    /* Two reads of a single-row table per AI call is two chances for the same
       workspace to be described two ways in one request. */
    const client = clientWithWorkspace({
      workspace_id: "w1",
      max_tier: null,
      monthly_budget_usd: null,
      content_policy_profile: "retail",
    });
    mockMessagesCreate.mockResolvedValue(reply("All fine here."));

    await client.complete(
      request({ metadata: { feature: "t", user_id: "u1", user_role: "cto", workspace_id: "w1" } }),
    );

    expect(mockLoadPolicy).toHaveBeenCalledTimes(1);
  });
});

describe("router content policy — where it must not reach", () => {
  it("does not gate the judge's verdict about an answer", async () => {
    /* A judge reporting "the answer guarantees a price" is doing its job. Gate
       it and the router withholds the FINDING rather than the claim, which
       inverts the feature. */
    process.env.AI_CONTENT_POLICY_PROFILE = "automotive";
    mockMessagesCreate.mockResolvedValue(
      reply("The answer guarantees the lowest price, which it cannot support."),
    );

    const res = await getAIClient().complete(
      request({
        metadata: {
          feature: "test.policy.judge",
          user_id: "u1",
          user_role: "cto",
          internal_check: true,
        },
      }),
    );

    expect(res.content).toContain("guarantees the lowest price");
    expect(refusals()).toHaveLength(0);
  });

  it("still redacts a credential on an internal call", async () => {
    /* internal_check exempts the CONTENT policy only. A feature must not be
       able to reach a wider exemption by borrowing the flag. */
    mockMessagesCreate.mockResolvedValue(reply("The key is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345."));

    const res = await getAIClient().complete(
      request({
        metadata: { feature: "t.judge", user_id: "u1", user_role: "cto", internal_check: true },
      }),
    );

    expect(res.content).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });
});

describe("router content policy — degrading, never failing", () => {
  it("returns the answer when the profile is nonsense", async () => {
    /* A typo in configuration costs industry coverage. It must not cost the
       baseline gate, and it must never cost the answer. */
    process.env.AI_CONTENT_POLICY_PROFILE = "aotumotive";
    const text = "Six colours are available on that model.";
    mockMessagesCreate.mockResolvedValue(reply(text));

    const res = await getAIClient().complete(request());

    expect(res.content).toBe(text);
  });

  it("does not fail the call when the workspace row cannot be read", async () => {
    const client = clientWithWorkspace(new Error("db down"));
    const text = "Six colours are available on that model.";
    mockMessagesCreate.mockResolvedValue(reply(text));

    const res = await client.complete(
      request({ metadata: { feature: "t", user_id: "u1", user_role: "cto", workspace_id: "w1" } }),
    );

    expect(res.content).toBe(text);
  });
});
