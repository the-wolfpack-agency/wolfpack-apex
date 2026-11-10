import {
  aiSpendFindings,
  deploymentFindings,
  deploymentNameMismatch,
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

describe("deployment name against the model it serves", () => {
  const dep = (name: string, model: string) => ({ accountId: RES, name, model, version: "1", sku: "GlobalStandard" });
  it("flags a deployment named for one model that serves another (gpt-4o-mini serving gpt-4o)", () => {
    expect(deploymentNameMismatch(dep("gpt-4o-mini", "gpt-4o"))).toBe(true);
    expect(deploymentNameMismatch(dep("gpt-4o-mini", "gpt-4.1"))).toBe(true);
    expect(deploymentNameMismatch(dep("text-embedding-3-small", "text-embedding-3-large"))).toBe(true);
  });
  it("accepts the model itself, a newer point release of the named one, and names that are not model ids", () => {
    expect(deploymentNameMismatch(dep("gpt-4o-mini", "gpt-4o-mini"))).toBe(false);
    expect(deploymentNameMismatch(dep("Deepseek-v3", "DeepSeek-V3.2"))).toBe(false);
    expect(deploymentNameMismatch(dep("Llama-3-3-70b", "Llama-3.3-70B-Instruct"))).toBe(false);
    expect(deploymentNameMismatch(dep("DeepSeek-V4-Flash", "DeepSeek-V4-Flash"))).toBe(false);
    expect(deploymentNameMismatch(dep("chat", "gpt-4o"))).toBe(false);
    expect(deploymentNameMismatch(dep("gpt-4o", ""))).toBe(false);
  });
  it("reports each mismatch as high, naming the account, the deployment and the served model", () => {
    const f = deploymentFindings([dep("gpt-4o-mini", "gpt-4o"), dep("gpt-4o", "gpt-4o")]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "high", rule: "ai-spend.deployment-model-mismatch", subject: "model-a / gpt-4o-mini" });
    expect(f[0].detail).toContain("serves gpt-4o 1");
  });
});
