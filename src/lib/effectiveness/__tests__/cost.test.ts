/**
 * Cost/usage aggregation - reader injected, no DB. Proves totals sum from the
 * per-model rows, the window is passed through, and empty state is zeros.
 */
import { computeCostUsage, type CostDeps, type CostByModel } from "../cost";

const rows: CostByModel[] = [
  { model: "gpt-4o-mini", provider: "openai", calls: 100, costUsd: 0.12, inputTokens: 50000, outputTokens: 8000 },
  { model: "claude-haiku-4-5", provider: "anthropic", calls: 40, costUsd: 0.03, inputTokens: 20000, outputTokens: 3000 },
];
const deps = (over: Partial<CostDeps> = {}): CostDeps => ({ loadByModel: async () => rows, ...over });

it("sums totals across the per-model rows", async () => {
  const r = await computeCostUsage("w1", "2026-08-19T00:00:00.000Z", deps());
  expect(r.totalCostUsd).toBe(0.15);
  expect(r.totalCalls).toBe(140);
  expect(r.totalInputTokens).toBe(70000);
  expect(r.totalOutputTokens).toBe(11000);
  expect(r.byModel).toHaveLength(2);
  expect(r.sinceIso).toBe("2026-08-19T00:00:00.000Z");
});

it("passes the workspace + since window to the reader", async () => {
  const seen: string[] = [];
  await computeCostUsage("w9", "2026-09-01T00:00:00.000Z", { loadByModel: async (ws, since) => { seen.push(ws, since); return []; } });
  expect(seen).toEqual(["w9", "2026-09-01T00:00:00.000Z"]);
});

it("empty state is all zeros", async () => {
  const r = await computeCostUsage("w1", "2026-09-01T00:00:00.000Z", deps({ loadByModel: async () => [] }));
  expect(r).toMatchObject({ totalCostUsd: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, byModel: [] });
});

it("rounds sub-cent sums honestly to 4dp", async () => {
  const r = await computeCostUsage("w1", "s", deps({ loadByModel: async () => [
    { model: "m", provider: "p", calls: 1, costUsd: 0.00011, inputTokens: 1, outputTokens: 1 },
    { model: "n", provider: "p", calls: 1, costUsd: 0.00019, inputTokens: 1, outputTokens: 1 },
  ] }));
  expect(r.totalCostUsd).toBe(0.0003);
});
