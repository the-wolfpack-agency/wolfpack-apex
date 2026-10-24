import {
  aiSpendFindings,
  isAiCost,
  normalizeUsageDate,
  parseCostQuery,
  shiftDay,
  summarizeAiSpend,
  type CostRow,
} from "../../../scripts/security/lib/ai-spend";

const RES = "/subscriptions/s/resourcegroups/rg/providers/microsoft.cognitiveservices/accounts/model-a";

function days(resourceId: string, values: number[], lastDay = "2026-10-23", service = "Foundry Models"): CostRow[] {
  // values[0] is the oldest of the 8 days, values[7] the last day.
  return values.map((cost, i) => ({
    resourceId,
    serviceName: service,
    resourceType: "microsoft.cognitiveservices/accounts",
    date: shiftDay(lastDay, i - (values.length - 1)),
    cost,
    currency: "USD",
  }));
}

describe("isAiCost", () => {
  it("keeps Cognitive Services, OpenAI, Foundry, Machine Learning and Copilot Studio; drops the rest", () => {
    expect(isAiCost("Foundry Models", "microsoft.cognitiveservices/accounts")).toBe(true);
    expect(isAiCost("Azure OpenAI", "")).toBe(true);
    expect(isAiCost("Machine Learning", "microsoft.machinelearningservices/workspaces")).toBe(true);
    expect(isAiCost("Microsoft Copilot Studio", "microsoft.powerplatform/accounts")).toBe(true);
    expect(isAiCost("Storage", "microsoft.storage/storageaccounts")).toBe(false);
    expect(isAiCost("Azure App Service", "microsoft.web/sites")).toBe(false);
    expect(isAiCost("Container Registry", "microsoft.containerregistry/registries")).toBe(false);
  });
});

describe("parseCostQuery", () => {
  it("reads rows by column name, normalizes dates and lower-cases resource ids", () => {
    const rows = parseCostQuery(
      [{ name: "Cost" }, { name: "UsageDate" }, { name: "ResourceId" }, { name: "ServiceName" }, { name: "ResourceType" }, { name: "Currency" }],
      [[0.358, 20261023, RES.toUpperCase(), "Foundry Models", "microsoft.cognitiveservices/accounts", "USD"]],
    );
    expect(rows).toEqual([
      { cost: 0.358, date: "2026-10-23", resourceId: RES, serviceName: "Foundry Models", resourceType: "microsoft.cognitiveservices/accounts", currency: "USD" },
    ]);
    expect(normalizeUsageDate("2026-10-23T00:00:00")).toBe("2026-10-23");
  });
});

describe("AI spend rules", () => {
  it("is quiet at the steady ~$0.36/day baseline", () => {
    const s = summarizeAiSpend(days(RES, [0.36, 0.36, 0.36, 0.36, 0.36, 0.36, 0.36, 0.36]), "2026-10-23");
    expect(s[0].last).toBeCloseTo(0.36);
    expect(s[0].trailingMean).toBeCloseTo(0.36);
    expect(aiSpendFindings(s, "2026-10-23", "sub")).toEqual([]);
  });

  it("is quiet after a drop (the Oct 18 step down from ~$15/day)", () => {
    const s = summarizeAiSpend(days(RES, [15, 15, 15, 10, 0.47, 0.38, 0.36, 0.36]), "2026-10-23");
    expect(aiSpendFindings(s, "2026-10-23", "sub")).toEqual([]);
  });

  it("flags a stolen-key shaped spike: over 3x the mean AND over $5", () => {
    const s = summarizeAiSpend(days(RES, [0.36, 0.36, 0.36, 0.36, 0.36, 0.36, 0.36, 40]), "2026-10-23");
    const f = aiSpendFindings(s, "2026-10-23", "sub");
    expect(f.map((x) => [x.rule, x.severity])).toEqual([["ai-spend.spike", "high"]]);
    expect(f[0].subject).toContain("model-a");
  });

  it("does not flag a relative jump that stays under $5", () => {
    const s = summarizeAiSpend(days(RES, [0.36, 0.36, 0.36, 0.36, 0.36, 0.36, 0.36, 4.5]), "2026-10-23");
    expect(aiSpendFindings(s, "2026-10-23", "sub")).toEqual([]);
  });

  it("does not flag a large day that is under 3x the mean", () => {
    const s = summarizeAiSpend(days(RES, [10, 10, 10, 10, 10, 10, 10, 25]), "2026-10-23");
    expect(aiSpendFindings(s, "2026-10-23", "sub")).toEqual([]);
  });

  it("flags a new AI resource, as high when its first day is already over $5", () => {
    const small = summarizeAiSpend(days(RES, [0, 0, 0, 0, 0, 0, 0, 0.5]), "2026-10-23");
    expect(aiSpendFindings(small, "2026-10-23", "sub").map((x) => [x.rule, x.severity])).toEqual([["ai-spend.new-resource", "medium"]]);
    const big = summarizeAiSpend(days(RES, [0, 0, 0, 0, 0, 0, 0, 12]), "2026-10-23");
    expect(aiSpendFindings(big, "2026-10-23", "sub").map((x) => [x.rule, x.severity])).toEqual([["ai-spend.new-resource-spike", "high"]]);
  });

  it("ignores non-AI rows and rows outside the window", () => {
    const rows = [
      ...days("/subscriptions/s/x/storage1", [0, 0, 0, 0, 0, 0, 0, 100], "2026-10-23", "Storage").map((r) => ({ ...r, resourceType: "microsoft.storage/storageaccounts" })),
      { ...days(RES, [100])[0], date: "2026-10-01" },
    ];
    expect(summarizeAiSpend(rows, "2026-10-23")).toEqual([]);
  });
});
