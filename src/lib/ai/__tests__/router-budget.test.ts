/**
 * router - workspace monthly-budget enforcement at the AI chokepoint.
 *
 * The budget mechanism (workspace_ai_policy.monthly_budget_usd + the
 * v_ai_cost_daily cost view + isOverBudget) existed but nothing called it.
 * These tests pin the gate wired into router.complete():
 *
 *   - over budget  -> call REFUSED (BudgetExceededError), provider.complete
 *                     NOT called, ai.request_blocked_over_budget fired.
 *   - under budget -> proceeds, provider called, no block event.
 *   - no budget set (monthly_budget_usd null) -> proceeds, no enforcement.
 *   - no policy row -> proceeds, no enforcement.
 *   - no workspace_id on the request -> governed under the shared
 *     __unattributed__ bucket (same governor), sampled trace emitted.
 *   - spend read fails -> fails OPEN with an ai.budget_check_degraded trace,
 *     rate-limited per bucket per 15 minutes.
 *   - block event carries { workspace_id, month_spend_usd, budget_usd, feature }.
 *
 * The provider SDKs are mocked; no real model is ever called.
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

import {
  _buildAIClientWithBudgetDepsForTests,
  _resetAIClientForTests,
  _resetSpendTracesForTests,
  BudgetExceededError,
} from "@/lib/ai/router";
import { UNATTRIBUTED_BUCKET } from "@/lib/ai/spend-guard";
import type { WorkspaceAIPolicy } from "@/lib/ai/workspace-policy";

const originalFetch = global.fetch;

function fakeOk(text = "hello", model = "claude-sonnet-4-6") {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    model,
  };
}

function policy(over: Partial<WorkspaceAIPolicy>): WorkspaceAIPolicy {
  return {
    workspace_id: "ws_client",
    max_tier: null,
    provider_override: undefined,
    monthly_budget_usd: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  _resetSpendTracesForTests();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  global.fetch = originalFetch;
});

/**
 * The gate used to refuse the moment spend passed the cap. That is what
 * OpenRouter's 402 does, and it is the wrong shape: a hard cap does not arrive
 * when the finance team is looking, it arrives while somebody is mid-sentence
 * to a client. Caps then get set high enough never to fire, or somebody raises
 * them in a hurry, and either way the control is theatre.
 *
 * Capability degrades before service is refused. These tests were rewritten to
 * the new contract rather than deleted, because the OLD assertion (nothing is
 * charged, the provider is never called) still has to hold at the ceiling.
 */
describe("router - workspace budget enforcement", () => {
  it("keeps answering over the cap, from a smaller model, and charges no premium call", async () => {
    const loadPolicy = jest.fn().mockResolvedValue(policy({ monthly_budget_usd: 100 }));
    const monthSpend = jest.fn().mockResolvedValue(150);
    const client = _buildAIClientWithBudgetDepsForTests({ loadPolicy, monthSpend });
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "still working" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-haiku-4-5",
    });

    const res = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "premium",
      metadata: { feature: "budget.over", workspace_id: "ws_client" },
    });

    /* The person keeps working. That is the whole difference from a 402. */
    expect(res.content).toBe("still working");
    /* And they were served by the cheapest model, so the bill stops climbing
       at the same rate: the premium model was never asked. */
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("REFUSES only at the ceiling, where a budget has become a malfunction", async () => {
    const loadPolicy = jest
      .fn()
      .mockResolvedValue(policy({ monthly_budget_usd: 100 }));
    const monthSpend = jest.fn().mockResolvedValue(200);
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy,
      monthSpend,
    });

    await expect(
      client.complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: { feature: "budget.over", workspace_id: "ws_client" },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fires ai.request_blocked_over_budget with the decision numbers", async () => {
    const loadPolicy = jest
      .fn()
      .mockResolvedValue(policy({ monthly_budget_usd: 100 }));
    const monthSpend = jest.fn().mockResolvedValue(250.5); // past the ceiling: a block, not a degrade
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy,
      monthSpend,
    });

    await client
      .complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: {
          feature: "budget.event",
          workspace_id: "ws_client",
          user_id: "u-9",
          user_role: "operator",
        },
      })
      .catch(() => {});

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, userId, userRole, meta] = mockTrackEvent.mock.calls[0];
    expect(event).toBe("ai.request_blocked_over_budget");
    expect(userId).toBe("u-9");
    expect(userRole).toBe("operator");
    expect(meta).toEqual({
      workspace_id: "ws_client",
      month_spend_usd: 250.5,
      budget_usd: 100,
      feature: "budget.event",
    });
  });

  it("BudgetExceededError carries details + a 402 status hint", async () => {
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: 50 })),
      monthSpend: jest.fn().mockResolvedValue(750), // past the ceiling
    });
    const err: unknown = await client
      .complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "cheap",
        metadata: { feature: "budget.details", workspace_id: "ws_client" },
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const budgetErr = err as BudgetExceededError;
    expect(budgetErr.status).toBe(402);
    expect(budgetErr.details).toEqual({
      workspace_id: "ws_client",
      month_spend_usd: 750,
      budget_usd: 50,
      feature: "budget.details",
    });
  });

  it("PROCEEDS (provider called) when spend is under budget; no block event", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const monthSpend = jest.fn().mockResolvedValue(40);
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: 100 })),
      monthSpend,
    });

    const out = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "budget.under", workspace_id: "ws_client" },
    });

    expect(out.provider_used).toBe("anthropic");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    /* The point of this assertion is that the call was NOT blocked. Asserting
       it by total event count made it brittle: a completion now also records
       its routing decision (ai.model_selected) for /admin/ai-router. Name the
       events instead — it says what this test means and cannot be broken by an
       unrelated event being added. */
    const names = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(names).toContain("ai.completion");
    expect(names).not.toContain("ai.request_blocked_over_budget");
  });

  it("bounds an unconfigured workspace by the platform default: a normal call still PROCEEDS, but spend IS now checked", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const monthSpend = jest.fn().mockResolvedValue(10); // well under the generous default backstop
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: null })),
      monthSpend,
    });

    const out = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "budget.nocap", workspace_id: "ws_client" },
    });

    expect(out.provider_used).toBe("anthropic");
    // The gap this closed: an unconfigured workspace is now bounded, so spend IS read.
    expect(monthSpend).toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("BACKSTOP: an unconfigured workspace over 2x the platform default is REFUSED", async () => {
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: null })),
      monthSpend: jest.fn().mockResolvedValue(60_000), // > 2 x the platform default backstop
    });
    await expect(
      client.complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: { feature: "budget.runaway", workspace_id: "ws_client" },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("PROCEEDS when there is no policy row for the workspace", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(null),
      monthSpend: jest.fn().mockResolvedValue(10), // low spend, under the default backstop
    });

    const out = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "budget.nopolicy", workspace_id: "ws_client" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("NO workspace_id is governed under the __unattributed__ bucket, and a normal call still PROCEEDS", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const loadPolicy = jest.fn();
    const monthSpend = jest.fn().mockResolvedValue(10);
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy,
      monthSpend,
    });

    const out = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "budget.noworkspace" },
    });

    expect(out.provider_used).toBe("anthropic");
    /* There is no workspace row to load, but there IS a bucket to read. This
       used to be "deps never consulted", which was the gap: no workspace, no
       limit. */
    expect(loadPolicy).not.toHaveBeenCalled();
    expect(monthSpend).toHaveBeenCalledWith(UNATTRIBUTED_BUCKET);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("an unattributed bucket over its cap DEGRADES rather than refuses (callers do not break)", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "still working" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-haiku-4-5",
    });
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn(),
      monthSpend: jest.fn().mockResolvedValue(1_200), // over the 1,000 default, under the 2,000 ceiling
    });
    const res = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "premium",
      metadata: { feature: "budget.unattributed.over" },
    });
    expect(res.content).toBe("still working");
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
    const degraded = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.budget_degraded");
    expect(degraded?.[3]).toMatchObject({ workspace_id: UNATTRIBUTED_BUCKET, state: "over" });
  });

  it("an unattributed bucket at 2x the cap is STOPPED, with a message that says how to fix the caller", async () => {
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn(),
      monthSpend: jest.fn().mockResolvedValue(2_000),
    });
    const err: unknown = await client
      .complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: { feature: "budget.unattributed.runaway" },
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toContain("metadata.workspace_id");
    expect((err as BudgetExceededError).details).toMatchObject({ workspace_id: UNATTRIBUTED_BUCKET, budget_usd: 1_000 });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    const names = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(names).toContain("ai.request_blocked_over_budget");
  });

  it("honors OGIAM_UNATTRIBUTED_MONTHLY_BUDGET_USD for the unattributed bucket only", async () => {
    process.env.OGIAM_UNATTRIBUTED_MONTHLY_BUDGET_USD = "10";
    try {
      const client = _buildAIClientWithBudgetDepsForTests({
        loadPolicy: jest.fn().mockResolvedValue(null),
        monthSpend: jest.fn().mockResolvedValue(25),
      });
      await expect(
        client.complete({
          messages: [{ role: "user", content: "x" }],
          max_tokens: 10,
          model_tier: "standard",
          metadata: { feature: "budget.unattributed.env" },
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);

      /* The same spend against a real workspace is well under the platform
         default, so the override did not leak into workspace caps. */
      mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
      const out = await client.complete({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 10,
        model_tier: "standard",
        metadata: { feature: "budget.unattributed.env", workspace_id: "ws_client" },
      });
      expect(out.provider_used).toBe("anthropic");
    } finally {
      delete process.env.OGIAM_UNATTRIBUTED_MONTHLY_BUDGET_USD;
    }
  });

  it("emits ai.request_unattributed at most once per feature per 15 minutes, carrying the held-back count", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      const client = _buildAIClientWithBudgetDepsForTests({
        loadPolicy: jest.fn(),
        monthSpend: jest.fn().mockResolvedValue(0),
      });
      const call = (feature: string) => {
        mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
        return client.complete({
          messages: [{ role: "user", content: "x" }],
          max_tokens: 10,
          model_tier: "cheap",
          metadata: { feature, user_id: "u-1", user_role: "member" },
        });
      };
      const traces = () => mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.request_unattributed");

      nowSpy.mockReturnValue(1_000_000);
      await call("brain.retrieval_relevance");
      await call("brain.retrieval_relevance");
      await call("brain.retrieval_relevance");
      await call("assistant_chat"); // a different feature is its own window
      expect(traces()).toHaveLength(2);
      expect(traces()[0][1]).toBe("u-1");
      expect(traces()[0][3]).toMatchObject({ feature: "brain.retrieval_relevance", suppressed_since_last: 0 });
      expect(traces()[1][3]).toMatchObject({ feature: "assistant_chat" });

      nowSpy.mockReturnValue(1_000_000 + 15 * 60_000);
      await call("brain.retrieval_relevance");
      expect(traces()).toHaveLength(3);
      expect(traces()[2][3]).toMatchObject({ feature: "brain.retrieval_relevance", suppressed_since_last: 2 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("an attributed call emits NO unattributed trace, and 'default' is a real workspace, not unattributed", async () => {
    const monthSpend = jest.fn().mockResolvedValue(0);
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(null),
      monthSpend,
    });
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "budget.default_ws", workspace_id: "default" },
    });
    expect(monthSpend).toHaveBeenCalledWith("default");
    const names = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(names).not.toContain("ai.request_unattributed");
  });

  it("ai.completion carries workspace_id when the caller gave one, and omits it when not", async () => {
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(null),
      monthSpend: jest.fn().mockResolvedValue(0),
    });
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "budget.attr", workspace_id: "ws_client" },
    });
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "cheap",
      metadata: { feature: "budget.attr" },
    });
    const completions = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.completion");
    expect(completions).toHaveLength(2);
    expect(completions[0][3].workspace_id).toBe("ws_client");
    /* Absent, not "default": the absent key is what the unattributed bucket
       sums, and "default" is a real workspace. */
    expect("workspace_id" in completions[1][3]).toBe(false);
  });

  it("a FAILED spend read fails OPEN and leaves an ai.budget_check_degraded trace, once per bucket per 15 minutes", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = _buildAIClientWithBudgetDepsForTests({
        loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: 100 })),
        monthSpend: jest.fn().mockRejectedValue(new Error("connection terminated")),
      });
      const call = () => {
        mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
        return client.complete({
          messages: [{ role: "user", content: "x" }],
          max_tokens: 10,
          model_tier: "premium",
          metadata: { feature: "budget.degraded", workspace_id: "ws_client" },
        });
      };
      const traces = () => mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.budget_check_degraded");

      nowSpy.mockReturnValue(5_000_000);
      const out = await call();
      /* Still answered: a read failure must never take down AI traffic. */
      expect(out.provider_used).toBe("anthropic");
      await call();
      expect(traces()).toHaveLength(1);
      expect(traces()[0][3]).toMatchObject({
        workspace_id: "ws_client",
        unattributed: false,
        budget_usd: 100,
        feature: "budget.degraded",
        error: "connection terminated",
        suppressed_since_last: 0,
      });
      expect(warn).toHaveBeenCalled();

      nowSpy.mockReturnValue(5_000_000 + 15 * 60_000);
      await call();
      expect(traces()).toHaveLength(2);
      expect(traces()[1][3]).toMatchObject({ suppressed_since_last: 1 });
      expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it("spend exactly at budget is NOT over -> proceeds", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: 100 })),
      monthSpend: jest.fn().mockResolvedValue(100),
    });
    const out = await client.complete({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      model_tier: "standard",
      metadata: { feature: "budget.exact", workspace_id: "ws_client" },
    });
    expect(out.provider_used).toBe("anthropic");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
