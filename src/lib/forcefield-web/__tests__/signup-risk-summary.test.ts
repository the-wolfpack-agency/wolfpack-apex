/**
 * Unit tests for the signup risk-summary dogfood. Proves it routes through the
 * injected AIClient with the right feature tag + cheap tier, returns the summary,
 * and GRACEFULLY degrades (never throws) on empty output, budget, no-provider, or
 * any other error - the review must never be blocked by the advisory summary.
 */
import { summarizeSignupRisk } from "../signup-risk-summary";
import { BudgetExceededError, NoProviderAvailableError, type AIClient } from "@/lib/ai/types";

const INPUT = { name: "Dana", email: "dana@acme.com", siteUrl: "acme.com", note: "evaluating" };
const CTX = { workspaceId: "w1", actor: { userId: "op-1", role: "admin" } };

const clientReturning = (content: string, extra: Partial<Record<string, unknown>> = {}): AIClient => ({
  complete: jest.fn().mockResolvedValue({
    content, model_used: "gpt-4o-mini", provider_used: "azure",
    input_tokens: 10, output_tokens: 20, cost_usd: 0.0001, latency_ms: 120, ...extra,
  }),
});

it("routes through the AI client with the forcefield feature tag + cheap tier", async () => {
  const client = clientReturning("Looks like a real business. LOOKS LEGITIMATE");
  const res = await summarizeSignupRisk(INPUT, CTX, client);
  expect(res).toEqual({ ok: true, summary: "Looks like a real business. LOOKS LEGITIMATE", model: "gpt-4o-mini", degraded: false });
  const req = (client.complete as jest.Mock).mock.calls[0][0];
  expect(req.metadata.feature).toBe("forcefield.signup_risk_summary");
  expect(req.metadata.workspace_id).toBe("w1");
  expect(req.model_tier).toBe("cheap");
  expect(req.sensitivity).toBe("confidential");
});

it("passes the degraded flag through so the caller knows the capability was not served", async () => {
  const client = clientReturning("note", { degraded: true });
  const res = await summarizeSignupRisk(INPUT, CTX, client);
  expect(res).toMatchObject({ ok: true, degraded: true });
});

it("empty model output -> unavailable (not a blank summary)", async () => {
  const res = await summarizeSignupRisk(INPUT, CTX, clientReturning("   "));
  expect(res).toEqual({ ok: false, reason: "unavailable" });
});

it("over budget -> typed over_budget, never throws", async () => {
  const client: AIClient = {
    complete: jest.fn().mockRejectedValue(new BudgetExceededError("cap", { workspace_id: "w1", month_spend_usd: 10, budget_usd: 10, feature: "f" })),
  };
  await expect(summarizeSignupRisk(INPUT, CTX, client)).resolves.toEqual({ ok: false, reason: "over_budget" });
});

it("no provider -> typed no_provider, never throws", async () => {
  const client: AIClient = { complete: jest.fn().mockRejectedValue(new NoProviderAvailableError("none")) };
  await expect(summarizeSignupRisk(INPUT, CTX, client)).resolves.toEqual({ ok: false, reason: "no_provider" });
});

it("any other error -> unavailable, never throws", async () => {
  const client: AIClient = { complete: jest.fn().mockRejectedValue(new Error("timeout")) };
  await expect(summarizeSignupRisk(INPUT, CTX, client)).resolves.toEqual({ ok: false, reason: "unavailable" });
});

describe("AI kill-switch (FORCEFIELD_AI_DISABLED)", () => {
  const ORIG = process.env.FORCEFIELD_AI_DISABLED;
  afterEach(() => { if (ORIG === undefined) delete process.env.FORCEFIELD_AI_DISABLED; else process.env.FORCEFIELD_AI_DISABLED = ORIG; });

  it("isForcefieldAiDisabled reads on/true/1 as disabled", async () => {
    const { isForcefieldAiDisabled } = await import("../signup-risk-summary");
    expect(isForcefieldAiDisabled({ FORCEFIELD_AI_DISABLED: "on" })).toBe(true);
    expect(isForcefieldAiDisabled({ FORCEFIELD_AI_DISABLED: "true" })).toBe(true);
    expect(isForcefieldAiDisabled({ FORCEFIELD_AI_DISABLED: "1" })).toBe(true);
    expect(isForcefieldAiDisabled({})).toBe(false);
    expect(isForcefieldAiDisabled({ FORCEFIELD_AI_DISABLED: "off" })).toBe(false);
  });

  it("returns disabled WITHOUT calling the model when the switch is on", async () => {
    process.env.FORCEFIELD_AI_DISABLED = "on";
    const client = { complete: jest.fn() };
    const res = await summarizeSignupRisk(INPUT, CTX, client);
    expect(res).toEqual({ ok: false, reason: "disabled" });
    expect(client.complete).not.toHaveBeenCalled(); // zero AI calls
  });
});
