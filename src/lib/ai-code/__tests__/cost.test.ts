/**
 * Factory cost meter: actual cost + cross-model comparison from the ONE pricing
 * registry (so factory and router estimates never drift).
 */
import { compareModelCosts, costOnModel, buildRunCost, usd } from "@/lib/ai-code/cost";
import { MODEL_REGISTRY } from "@/lib/ai/models/registry";

test("usd formats sub-cent to 4dp, else 2dp", () => {
  expect(usd(0.0003)).toBe("$0.0003");
  expect(usd(1.5)).toBe("$1.50");
  expect(usd(0)).toBe("$0.00");
});

test("costOnModel is list price times tokens", () => {
  const gpt4oMini = MODEL_REGISTRY.find((m) => m.id === "gpt-4o-mini")!;
  // 1000 in + 1000 out at 0.00015 / 0.0006 per 1k = 0.00075
  expect(costOnModel(gpt4oMini, 1000, 1000)).toBeCloseTo(0.00075, 6);
});

describe("compareModelCosts", () => {
  const rows = compareModelCosts(1000, 1000);
  it("returns rows sorted cheapest-first", () => {
    for (let i = 1; i < rows.length; i++) expect(rows[i].costUsd).toBeGreaterThanOrEqual(rows[i - 1].costUsd);
  });
  it("folds azure mirrors into one row per base model", () => {
    expect(rows.some((r) => r.model.startsWith("azure-"))).toBe(false);
    const ids = rows.map((r) => r.model);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
  });
  it("includes popular models to compare against", () => {
    expect(rows.map((r) => r.model)).toContain("gpt-4o-mini");
  });
});

describe("buildRunCost", () => {
  it("counts model passes as 1 executor + repair attempts (iteration overhead)", () => {
    const c = buildRunCost({ actualUsd: 0.002, inputTokens: 500, outputTokens: 800, repairAttempts: 2 });
    expect(c.attempts).toBe(3);
    expect(c.actualUsd).toBe(0.002);
    expect(c.comparison.length).toBeGreaterThan(0);
  });
  it("tolerates null usage (no executor cost captured)", () => {
    const c = buildRunCost({ actualUsd: null, inputTokens: null, outputTokens: null, repairAttempts: 0 });
    expect(c.actualUsd).toBe(0);
    expect(c.attempts).toBe(1);
  });
});
