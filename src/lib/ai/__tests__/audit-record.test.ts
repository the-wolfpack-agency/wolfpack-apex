/**
 * The evidence a regulated client can check.
 *
 * OpenRouter's own documentation lists detailed audit logs among the things
 * its Guardrails do NOT cover, and Router.com's launch does not mention
 * governance at all. Both can say "we filter". Neither can hand a compliance
 * officer something that officer can verify without trusting the vendor.
 *
 * The rule these tests exist to enforce is the one that makes such a record
 * safe to keep forever: it says WHAT HAPPENED and never carries the content it
 * is auditing. A record that quotes what it caught becomes the largest copy of
 * that content in the estate, in a table designed never to be deleted.
 */
import { buildRouterAuditEntry, ROUTER_AUDIT_ACTION, type RouterAuditFacts } from "@/lib/ai/audit-record";

const facts = (over: Partial<RouterAuditFacts> = {}): RouterAuditFacts => ({
  workspaceId: "ws_1",
  userId: "u_1",
  feature: "assistant.chat",
  model: "azure-gpt-4o-mini",
  provider: "azure-openai",
  requestedTier: "premium",
  servedTier: "premium",
  inputTokens: 900,
  outputTokens: 300,
  costUsd: 0.0021,
  withheldOutbound: 0,
  withheldInbound: 0,
  withheldKinds: [],
  injectionAttempts: 0,
  ...over,
});

describe("a row carries what happened, never the content", () => {
  test("no prompt, no answer, no redacted value: counts and kinds only", () => {
    const entry = buildRouterAuditEntry(
      facts({
        withheldOutbound: 2,
        withheldInbound: 1,
        withheldKinds: ["credit_card", "api_key"],
      }),
    );
    const serialised = JSON.stringify(entry);

    /* The values the gate caught must be nowhere in the record, which is what
       lets this table be kept forever and exported to a client. */
    expect(serialised).not.toMatch(/\d{4}[- ]?\d{4}/);
    expect(serialised).not.toContain("sk-");
    expect(entry.afterState.withheld_outbound).toBe(2);
    expect(entry.afterState.withheld_inbound).toBe(1);
    // Sorted, so two identical calls produce identical rows and identical hashes.
    expect(entry.afterState.withheld_kinds).toEqual(["api_key", "credit_card"]);
  });

  test("the row says so about itself, for whoever reads an export in a year", () => {
    expect(buildRouterAuditEntry(facts()).afterState.contains_content).toBe(false);
  });
});

describe("what an auditor actually asks", () => {
  test("which model answered, at what cost, in which tenancy", () => {
    const entry = buildRouterAuditEntry(facts());
    expect(entry.action).toBe(ROUTER_AUDIT_ACTION);
    expect(entry.resourceType).toBe("ai_call");
    /* The workspace, not a per-call id: "what happened in this tenancy" is the
       question, and a random id per row answers one nobody asks. */
    expect(entry.resourceId).toBe("ws_1");
    expect(entry.afterState).toMatchObject({
      model: "azure-gpt-4o-mini",
      provider: "azure-openai",
      cost_usd: 0.0021,
      input_tokens: 900,
      output_tokens: 300,
    });
  });

  test("a governed call records BOTH tiers, so the difference is explainable", () => {
    const entry = buildRouterAuditEntry(
      facts({ requestedTier: "premium", servedTier: "cheap", budgetState: "over" }),
    );
    expect(entry.afterState).toMatchObject({
      requested_tier: "premium",
      served_tier: "cheap",
      budget_state: "over",
    });
  });

  test("an ordinary call carries no budget state at all", () => {
    /* Absence is the signal: a field reading "ok" on every row trains a reader
       to skip the column that matters. */
    expect(buildRouterAuditEntry(facts()).afterState).not.toHaveProperty("budget_state");
  });

  test("a document that tried to give instructions is counted", () => {
    expect(buildRouterAuditEntry(facts({ injectionAttempts: 2 })).afterState.injection_attempts).toBe(2);
  });
});
