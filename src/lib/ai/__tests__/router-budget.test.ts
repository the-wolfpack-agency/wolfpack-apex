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
 *   - no workspace_id on the request -> proceeds, deps never consulted.
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
  BudgetExceededError,
} from "@/lib/ai/router";
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

describe("router - workspace budget enforcement", () => {
  it("REFUSES the call when the workspace is over budget; provider not called", async () => {
    const loadPolicy = jest
      .fn()
      .mockResolvedValue(policy({ monthly_budget_usd: 100 }));
    const monthSpend = jest.fn().mockResolvedValue(150);
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
    const monthSpend = jest.fn().mockResolvedValue(150.5);
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
      month_spend_usd: 150.5,
      budget_usd: 100,
      feature: "budget.event",
    });
  });

  it("BudgetExceededError carries details + a 402 status hint", async () => {
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(policy({ monthly_budget_usd: 50 })),
      monthSpend: jest.fn().mockResolvedValue(75),
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
      month_spend_usd: 75,
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
    // only ai.completion, never ai.request_blocked_over_budget
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent.mock.calls[0][0]).toBe("ai.completion");
  });

  it("PROCEEDS when policy exists but monthly_budget_usd is null (no enforcement)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const monthSpend = jest.fn();
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
    // spend was never even queried - no budget means no need to read cost
    expect(monthSpend).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("PROCEEDS when there is no policy row for the workspace", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const client = _buildAIClientWithBudgetDepsForTests({
      loadPolicy: jest.fn().mockResolvedValue(null),
      monthSpend: jest.fn(),
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

  it("PROCEEDS with NO workspace_id - gate never consults deps (no regression)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(fakeOk("ok"));
    const loadPolicy = jest.fn();
    const monthSpend = jest.fn();
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
    expect(loadPolicy).not.toHaveBeenCalled();
    expect(monthSpend).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
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
