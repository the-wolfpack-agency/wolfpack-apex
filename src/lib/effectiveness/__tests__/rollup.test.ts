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
    ...over,
  };
}
const review = (outcome: string, findingCount = 0) => ({ id: "r", ref: "pr", author: "a", outcome, highestSeverity: null, findingCount, createdAt: "2026-09-17" });
const trip = (agent: string, contained: boolean) => ({ id: "t", agent, whenIso: "2026-09-17", riskTier: "critical", reason: "x", contained });
const canary = (active: boolean) => ({ id: "c", kind: "token" as const, seededIn: "s", valueHint: "****1234", active, createdAt: "2026-09-17" });

it("empty state is all zeros and NOT sample-capped (no fabricated totals)", async () => {
  const r = await computeEffectiveness("w1", deps());
  expect(r.secureAgent).toEqual({ changesGoverned: 0, blocked: 0, sentToHuman: 0, allowed: 0, risksCaught: 0 });
  expect(r.forcefield).toEqual({ decoysActive: 0, trips: 0, agentsContained: 0 });
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
