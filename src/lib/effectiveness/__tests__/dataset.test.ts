/**
 * Labeled-dataset export - readers injected, no DB. Proves the labels are the
 * platform's own decisions, the features are safe (no diff/payload/secret), and
 * the JSONL is one example per line.
 */
import { buildDataset, toJsonl, type DatasetDeps, type DatasetExample } from "../dataset";

function deps(over: Partial<DatasetDeps> = {}): DatasetDeps {
  return { listReviews: async () => [], listTrips: async () => [], ...over };
}
const review = (outcome: string, over: Record<string, unknown> = {}) => ({ id: "r", ref: "pr-1", author: "gpt-4o-mini", outcome, highestSeverity: "critical", findingCount: 2, createdAt: "2026-09-17", ...over });
const trip = (contained: boolean) => ({ id: "t1", agent: "agent-x", whenIso: "2026-09-17", riskTier: "critical", reason: "1 canary trip", contained });

it("builds secure-agent examples labeled by the gate verdict, with safe features only", async () => {
  const out = await buildDataset("w1", deps({ listReviews: async () => [review("block")] }));
  expect(out.counts.secureAgent).toBe(1);
  const ex = out.examples[0];
  expect(ex.source).toBe("secure_agent");
  expect(ex.label).toBe("block"); // the gate's own verdict is the label
  expect(ex.features).toEqual({ author: "gpt-4o-mini", highestSeverity: "critical", findingCount: 2 });
  // No raw diff / payload / secret-bearing field in the example.
  const serialized = JSON.stringify(ex);
  expect(serialized).not.toMatch(/diff|payload|password|secret|token/i);
});

it("builds forcefield examples labeled contained vs monitored", async () => {
  const out = await buildDataset("w1", deps({ listTrips: async () => [trip(true), trip(false)] }));
  expect(out.counts.forcefield).toBe(2);
  expect(out.examples.map((e) => e.label)).toEqual(["contained", "monitored"]);
  expect(out.examples[0].features).toEqual({ riskTier: "critical", agent: "agent-x" });
});

it("handles a null author without leaking undefined", async () => {
  const out = await buildDataset("w1", deps({ listReviews: async () => [review("allow", { author: null })] }));
  expect(out.examples[0].features.author).toBe("unknown");
});

it("counts total across both sources", async () => {
  const out = await buildDataset("w1", deps({
    listReviews: async () => [review("allow"), review("block")],
    listTrips: async () => [trip(true)],
  }));
  expect(out.counts).toEqual({ secureAgent: 2, forcefield: 1, total: 3 });
});

it("toJsonl emits one parseable example per line", () => {
  const examples: DatasetExample[] = [
    { source: "secure_agent" as const, label: "block", features: { author: "a", highestSeverity: "critical", findingCount: 1 }, ref: "pr", at: "t" },
    { source: "forcefield" as const, label: "contained", features: { riskTier: "critical", agent: "x" }, ref: "t1", at: "t" },
  ];
  const lines = toJsonl(examples).split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).label).toBe("block");
  expect(JSON.parse(lines[1]).source).toBe("forcefield");
});
