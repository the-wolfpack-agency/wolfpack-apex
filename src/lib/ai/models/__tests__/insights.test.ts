/**
 * Reading the router's decisions back.
 *
 * The tests that earn their place are about the difference between a missing
 * cost estimate and a zero one, and between "estimated" and "billed". Both are
 * ways this surface could put a confidently wrong number in front of someone
 * who would reconcile it against an invoice.
 */
jest.mock("@/lib/db", () => ({ query: jest.fn() }));

import { summarizeDecisions, describeInsights, describeReason, modelAvailability, getRouterInsights, describeMissingConfig } from "../insights";
import { MODEL_REGISTRY } from "../registry";
import { query } from "@/lib/db";

const q = query as jest.Mock;

function row(over: Record<string, unknown> = {}) {
  return {
    model_id: "gpt-4o-mini",
    provider: "azure",
    tier: "small",
    reason: "cheapest_at_tier",
    estimated_cost_usd: "0.0012",
    fallback_from: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  q.mockReset();
});

describe("a decision with no cost estimate", () => {
  it("is counted as unestimated, NOT as zero cost", () => {
    // Counting it as zero would drag the average down and quietly understate
    // what the fleet is spending.
    const s = summarizeDecisions([row(), row({ estimated_cost_usd: null })]);
    expect(s.decisionsWithoutEstimate).toBe(1);
    expect(s.usage[0].decisions).toBe(2);
    expect(s.usage[0].estimated).toBe(1);
  });

  it("treats an unparseable number the same way", () => {
    const s = summarizeDecisions([row({ estimated_cost_usd: "not-a-number" })]);
    expect(s.decisionsWithoutEstimate).toBe(1);
    expect(s.estimatedCostUsd).toBe(0);
  });

  it("with no completed calls, says spend cannot be measured", () => {
    /* This asserted the headline warned that the estimate "understates the real
       figure". The warning was true and useless: it apologized for a number
       instead of reporting the one we had. ai.completion carries the
       provider's own cost for every call that ran, and the headline now reads
       that instead (see insights-actuals.test.ts).

       No completed calls at all is the one case where the estimate gap still
       matters, and it means completions are not being recorded, which is a
       different and worse problem than a missing estimate. */
    const line = describeInsights({
      totalDecisions: 10,
      smallTierShare: 0.5,
      fallbacks: 0,
      decisionsWithoutEstimate: 4,
    });
    expect(line).toMatch(/no completed calls recorded/);
    expect(line).toMatch(/4 decisions had no estimate either/);
  });
});

describe("summarizeDecisions", () => {
  it("groups by model and sums the estimate", () => {
    const s = summarizeDecisions([row(), row(), row({ model_id: "gpt-4o", tier: "large" })]);
    expect(s.usage.map((u) => u.modelId)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(s.usage[0].decisions).toBe(2);
    expect(s.usage[0].estimatedCostUsd).toBeCloseTo(0.0024, 6);
  });

  it("counts a fallback both per model and overall", () => {
    const s = summarizeDecisions([row({ fallback_from: "o1-preview" }), row()]);
    expect(s.fallbacks).toBe(1);
    expect(s.usage[0].fallbacks).toBe(1);
  });

  it("reports the share served by the cheapest tier, which is the efficiency number", () => {
    const s = summarizeDecisions([row({ tier: "small" }), row({ tier: "large", model_id: "gpt-4o" })]);
    expect(s.smallTierShare).toBe(0.5);
  });

  it("returns null rather than 0 for the share when nothing ran", () => {
    // 0% would read as "we never use the cheap model", which is a finding.
    // Nothing recorded is not a finding.
    expect(summarizeDecisions([]).smallTierShare).toBeNull();
  });

  it("drops a row with no model id instead of inventing one", () => {
    expect(summarizeDecisions([row({ model_id: null })]).totalDecisions).toBe(0);
  });

  it("orders models by how much they are used", () => {
    const s = summarizeDecisions([row({ model_id: "a" }), row({ model_id: "b" }), row({ model_id: "b" })]);
    expect(s.usage.map((u) => u.modelId)).toEqual(["b", "a"]);
  });

  it("does not carry float noise into a money figure", () => {
    // An estimate quoted to fourteen decimal places looks more precise than it
    // has any right to.
    const s = summarizeDecisions([row({ estimated_cost_usd: "0.1" }), row({ estimated_cost_usd: "0.2" })]);
    expect(s.estimatedCostUsd).toBe(0.3);
  });
});

describe("describeReason", () => {
  it("turns a machine reason code into a sentence", () => {
    expect(describeReason("cheapest_at_tier")).toMatch(/cheapest model that met the requirement/);
    expect(describeReason("downgraded_no_tier_available")).toMatch(/no model met the requirement/);
  });

  it("passes an unknown code through rather than hiding it", () => {
    // A reason added later must still appear, even before someone writes copy.
    expect(describeReason("brand_new_reason")).toBe("brand_new_reason");
  });
});

describe("modelAvailability", () => {
  it("names the missing configuration rather than just saying unavailable", () => {
    // "Unavailable" makes someone go digging. The env var name is the fix.
    const models = modelAvailability({} as unknown as NodeJS.ProcessEnv);
    expect(models.every((m) => !m.available)).toBe(true);
    const openai = models.find((m) => m.provider === "openai");
    if (openai) expect(openai.blockedBy).toMatch(/OPENAI_API_KEY/);
    // A CLASSIC Azure model specifically. Foundry-served models live on their
    // own endpoint and correctly name AZURE_AI_FOUNDRY_* instead, so picking
    // "the first azure model" now asserts the wrong thing.
    const classicAzure = models.find(
      (m) => m.provider === "azure" && !MODEL_REGISTRY.find((s) => s.id === m.modelId)?.endpointEnvVar,
    );
    if (classicAzure) expect(classicAzure.blockedBy).toMatch(/AZURE_OPENAI_ENDPOINT/);
  });

  it("distinguishes a missing deployment name from missing credentials", () => {
    // On Azure these are different problems with different fixes.
    const env = { AZURE_OPENAI_ENDPOINT: "https://x", AZURE_OPENAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    const withDeployment = modelAvailability(env).filter((m) => m.provider === "azure" && !m.available);
    for (const m of withDeployment) expect(m.blockedBy).toMatch(/_DEPLOYMENT|not set/);
  });

  it("lists available models first, so the useful ones are at the top", () => {
    const env = { OPENAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    const models = modelAvailability(env);
    const firstUnavailable = models.findIndex((m) => !m.available);
    const lastAvailable = models.map((m) => m.available).lastIndexOf(true);
    if (firstUnavailable !== -1 && lastAvailable !== -1) expect(lastAvailable).toBeLessThan(firstUnavailable);
  });

  it("carries list prices so the page can show what a model costs", () => {
    const models = modelAvailability({} as unknown as NodeJS.ProcessEnv);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.inputPricePer1kUsd).toBe("number");
      expect(typeof m.outputPricePer1kUsd).toBe("number");
    }
  });
});

describe("getRouterInsights", () => {
  const ORIGINAL = process.env.DATABASE_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL;
  });

  it("still reports availability when history cannot be read", async () => {
    // "Which models are configured" is answerable from the environment alone,
    // and it is the more actionable half of the page.
    process.env.DATABASE_URL = "postgres://x";
    q.mockRejectedValue(new Error("db down"));
    const out = await getRouterInsights();
    expect(out.models.length).toBeGreaterThan(0);
    expect(out.totalDecisions).toBe(0);
    expect(out.headline).toMatch(/nothing to measure/i);
  });

  it("reads only routing decisions, within the window", async () => {
    process.env.DATABASE_URL = "postgres://x";
    q.mockResolvedValue({ rows: [] });
    await getRouterInsights(7);
    expect(q.mock.calls[0][0]).toContain("ai.model_selected");
    expect(q.mock.calls[0][1]).toEqual([7]);
  });

  it("does not query at all with no database configured", async () => {
    delete process.env.DATABASE_URL;
    const out = await getRouterInsights();
    expect(q).not.toHaveBeenCalled();
    expect(out.models.length).toBeGreaterThan(0);
  });
});

describe("the blocked-by message names EVERY missing variable", () => {
  const classic = {
    AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
    AZURE_OPENAI_API_KEY: "k",
  } as unknown as NodeJS.ProcessEnv;

  it("names all three for a Foundry model, not just the deployment", () => {
    // The bug this fixes. The old message checked the CLASSIC Azure pair — which
    // was set — and reported only the deployment name. Someone would set that,
    // redeploy, and see "Not Configured" again with no new information. A
    // diagnostic that leads you through whack-a-mole is worse than silence,
    // because you trust it.
    const deepseek = MODEL_REGISTRY.find((m) => m.id === "azure-deepseek-v3")!;
    const message = describeMissingConfig(deepseek, classic);
    expect(message).toContain("AZURE_AI_FOUNDRY_ENDPOINT");
    expect(message).toContain("AZURE_AI_FOUNDRY_API_KEY");
    expect(message).toContain("AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK");
  });

  it("does not blame the classic Azure vars for a model that does not use them", () => {
    const deepseek = MODEL_REGISTRY.find((m) => m.id === "azure-deepseek-v3")!;
    expect(describeMissingConfig(deepseek, classic)).not.toContain("AZURE_OPENAI_ENDPOINT");
  });

  it("names just one when only one is missing", () => {
    const withFoundry = {
      ...classic,
      AZURE_AI_FOUNDRY_ENDPOINT: "https://x.services.ai.azure.com/models",
      AZURE_AI_FOUNDRY_API_KEY: "k",
    } as unknown as NodeJS.ProcessEnv;
    const deepseek = MODEL_REGISTRY.find((m) => m.id === "azure-deepseek-v3")!;
    expect(describeMissingConfig(deepseek, withFoundry)).toBe("AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK is not set");
  });

  it("is derived from the spec, so a model added later cannot be mis-described", () => {
    // A rule written before a model exists cannot describe it correctly.
    for (const spec of MODEL_REGISTRY) {
      const message = describeMissingConfig(spec, {} as unknown as NodeJS.ProcessEnv);
      if (spec.endpointEnvVar) expect(message).toContain(spec.endpointEnvVar);
      if (spec.deploymentEnvVar) expect(message).toContain(spec.deploymentEnvVar);
    }
  });
});
