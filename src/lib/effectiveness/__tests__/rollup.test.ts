/**
 * Effectiveness rollup - aggregation math + the truthfulness invariants. Readers
 * are injected, so no DB.
 */
import { computeEffectiveness, type EffectivenessDeps } from "../rollup";

function deps(over: Partial<EffectivenessDeps> = {}): EffectivenessDeps {
  return {
    listReviews: async () => [],
    listTrips: async () => [],
    listCanaries: async () => [],
    listDecisions: async () => [],
    monthSpend: async () => null,
    listEnforcement: async () => ({ capabilityDenied: 0, connectorScopeDenied: 0, ceilingHits: 0, conductDenied: 0, total: 0 }),
    ...over,
  };
}
const review = (outcome: string, findingCount = 0) => ({ id: "r", ref: "pr", author: "a", outcome, highestSeverity: null, findingCount, createdAt: "2026-09-17" });
const trip = (agent: string, contained: boolean) => ({ id: "t", agent, whenIso: "2026-09-17", riskTier: "critical", reason: "x", contained });
const canary = (active: boolean) => ({ id: "c", kind: "token" as const, seededIn: "s", valueHint: "****1234", active, createdAt: "2026-09-17" });
const decision = (effective_outcome: string, over: Record<string, unknown> = {}) => ({
  id: "d", created_at: "2026-09-17", principal_agent: "agent-1", on_behalf_user_id: "u", on_behalf_role: "admin",
  tool: "t", capability: "c", is_mutation: true, surface: null, risk_tier: "standard",
  intended_outcome: effective_outcome, effective_outcome, enforced: true,
  would_block: effective_outcome === "deny" || effective_outcome === "escalate",
  rule_id: "R-X", reason: null, policy_version: "1", ...over,
});

it("empty state is all zeros and NOT sample-capped (no fabricated totals)", async () => {
  const r = await computeEffectiveness("w1", deps());
  expect(r.secureAgent).toEqual({ changesGoverned: 0, blocked: 0, sentToHuman: 0, allowed: 0, risksCaught: 0 });
  expect(r.forcefield).toEqual({ decoysActive: 0, trips: 0, agentsContained: 0 });
  expect(r.governance).toEqual({ actionsGoverned: 0, denied: 0, escalated: 0, transformed: 0, allowed: 0, wouldBlock: 0, agentsActive: 0 });
  expect(r.cost).toEqual({ monthToDateUsd: 0, measured: false }); // null spend -> not measured, never a fabricated 0
  expect(r.enforcement).toEqual({ capabilityDenied: 0, connectorScopeDenied: 0, ceilingHits: 0, conductDenied: 0, total: 0 });
  expect(r.sampleCapped).toBe(false);
});

it("counts secure-agent outcomes and only counts risks caught on NON-allowed changes", async () => {
  const r = await computeEffectiveness("w1", deps({
    listReviews: async () => [review("block", 3), review("escalate", 2), review("allow", 5), review("allow", 0)],
  }));
  expect(r.secureAgent.changesGoverned).toBe(4);
  expect(r.secureAgent.blocked).toBe(1);
  expect(r.secureAgent.sentToHuman).toBe(1);
  expect(r.secureAgent.allowed).toBe(2);
  expect(r.secureAgent.risksCaught).toBe(5); // 3 + 2; the 5 findings on an ALLOWED change are not "caught bad code"
});

it("counts forcefield trips and DISTINCT contained agents (a repeat offender counts once)", async () => {
  const r = await computeEffectiveness("w1", deps({
    listTrips: async () => [trip("agent-x", true), trip("agent-x", true), trip("agent-y", true), trip("agent-z", false)],
    listCanaries: async () => [canary(true), canary(true), canary(false)],
  }));
  expect(r.forcefield.trips).toBe(4);
  expect(r.forcefield.agentsContained).toBe(2); // x and y; x deduped, z not contained
  expect(r.forcefield.decoysActive).toBe(2); // only active decoys
});

it("flags sampleCapped when a reader returns a full page (count is a lower bound)", async () => {
  const many = Array.from({ length: 100 }, () => review("allow"));
  const r = await computeEffectiveness("w1", deps({ listReviews: async () => many }));
  expect(r.sampleCapped).toBe(true);
});

it("counts per-action governance by the gate's effective outcome and dedups active agents", async () => {
  const r = await computeEffectiveness("w1", deps({
    listDecisions: async () => [
      decision("allow"), decision("allow", { principal_agent: "agent-2" }),
      decision("deny"), decision("escalate"), decision("transform"),
    ],
  }));
  expect(r.governance.actionsGoverned).toBe(5);
  expect(r.governance.allowed).toBe(2);
  expect(r.governance.denied).toBe(1);
  expect(r.governance.escalated).toBe(1);
  expect(r.governance.transformed).toBe(1);
  expect(r.governance.wouldBlock).toBe(2); // the deny + the escalate
  expect(r.governance.agentsActive).toBe(2); // agent-1 (deduped across 4 rows) + agent-2
});

it("reports month-to-date cost as measured when a number is returned, 0 stays measured", async () => {
  const paid = await computeEffectiveness("w1", deps({ monthSpend: async () => 12.5 }));
  expect(paid.cost).toEqual({ monthToDateUsd: 12.5, measured: true });
  const zero = await computeEffectiveness("w1", deps({ monthSpend: async () => 0 }));
  expect(zero.cost).toEqual({ monthToDateUsd: 0, measured: true }); // a real 0 is measured
});

it("flags sampleCapped when the decisions reader returns a full page", async () => {
  const many = Array.from({ length: 200 }, () => decision("allow"));
  const r = await computeEffectiveness("w1", deps({ listDecisions: async () => many }));
  expect(r.sampleCapped).toBe(true);
});

it("surfaces downstream enforcement denials from the enforcement reader", async () => {
  const r = await computeEffectiveness("w1", deps({
    listEnforcement: async () => ({ capabilityDenied: 3, connectorScopeDenied: 1, ceilingHits: 2, conductDenied: 1, total: 7 }),
  }));
  expect(r.enforcement).toEqual({ capabilityDenied: 3, connectorScopeDenied: 1, ceilingHits: 2, conductDenied: 1, total: 7 });
});
