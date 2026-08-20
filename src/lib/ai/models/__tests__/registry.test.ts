/**
 * Registry tests - data integrity + env-gated availability. Pure, no network.
 */

import {
  MODEL_REGISTRY,
  TIER_ORDER,
  getModel,
  isModelAvailable,
  listModels,
} from "../registry";
import type { CapabilityTier, ModelProvider } from "../types";

/* Every provider the gateway can serve. "anthropic" joined when the registry
   started describing the Claude models anthropic-provider.ts had been calling
   all along, which is what let selection compare them on price. */
const VALID_PROVIDERS: ModelProvider[] = ["openai", "azure", "anthropic"];
const VALID_TIERS: CapabilityTier[] = ["small", "large", "reasoning"];

/** Build a hermetic env object typed as ProcessEnv for injection. */
function env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("MODEL_REGISTRY data integrity", () => {
  it("is frozen (immutable at runtime)", () => {
    expect(Object.isFrozen(MODEL_REGISTRY)).toBe(true);
  });

  it("is non-empty and listModels mirrors it", () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
    expect(listModels()).toBe(MODEL_REGISTRY);
  });

  it("has unique ids", () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers at least small, large, and reasoning tiers", () => {
    const tiers = new Set(MODEL_REGISTRY.map((m) => m.capabilityTier));
    expect(tiers.has("small")).toBe(true);
    expect(tiers.has("large")).toBe(true);
    expect(tiers.has("reasoning")).toBe(true);
  });

  it("includes both an OpenAI and an Azure mini, an Azure 4o, and an o-series", () => {
    expect(getModel("gpt-4o-mini")?.provider).toBe("openai");
    expect(getModel("azure-gpt-4o-mini")?.provider).toBe("azure");
    expect(getModel("azure-gpt-4o")?.capabilityTier).toBe("large");
    expect(getModel("o4-mini")?.capabilityTier).toBe("reasoning");
  });

  it.each(MODEL_REGISTRY.map((m) => [m.id, m] as const))(
    "%s has valid provider/tier, positive prices and context window",
    (_id, spec) => {
      expect(VALID_PROVIDERS).toContain(spec.provider);
      expect(VALID_TIERS).toContain(spec.capabilityTier);
      expect(spec.contextWindow).toBeGreaterThan(0);
      expect(spec.inputPricePer1kUsd).toBeGreaterThan(0);
      expect(spec.outputPricePer1kUsd).toBeGreaterThan(0);
    },
  );

  it("declares a deploymentEnvVar for every azure model and none for openai", () => {
    for (const spec of MODEL_REGISTRY) {
      if (spec.provider === "azure") {
        expect(typeof spec.deploymentEnvVar).toBe("string");
        expect(spec.deploymentEnvVar!.length).toBeGreaterThan(0);
      } else {
        expect(spec.deploymentEnvVar).toBeUndefined();
      }
    }
  });

  it("orders tiers small < large < reasoning", () => {
    expect(TIER_ORDER.small).toBeLessThan(TIER_ORDER.large);
    expect(TIER_ORDER.large).toBeLessThan(TIER_ORDER.reasoning);
  });
});

describe("getModel", () => {
  it("returns the spec on a hit", () => {
    expect(getModel("gpt-4o")?.id).toBe("gpt-4o");
  });

  it("returns undefined on a miss (no throw)", () => {
    expect(getModel("does-not-exist")).toBeUndefined();
  });
});

describe("isModelAvailable (env-gated, hermetic)", () => {
  const openai = getModel("gpt-4o-mini")!;
  const azureMini = getModel("azure-gpt-4o-mini")!;
  const azure4o = getModel("azure-gpt-4o")!;

  it("openai model needs OPENAI_API_KEY", () => {
    expect(isModelAvailable(openai, env())).toBe(false);
    expect(isModelAvailable(openai, env({ OPENAI_API_KEY: "" }))).toBe(false);
    expect(isModelAvailable(openai, env({ OPENAI_API_KEY: "sk-x" }))).toBe(true);
  });

  it("azure model needs endpoint + key + its deployment env var", () => {
    // Missing everything.
    expect(isModelAvailable(azureMini, env())).toBe(false);
    // Base creds but no deployment var.
    expect(
      isModelAvailable(
        azureMini,
        env({
          AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
          AZURE_OPENAI_API_KEY: "k",
        }),
      ),
    ).toBe(false);
    // Full set.
    expect(
      isModelAvailable(
        azureMini,
        env({
          AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
          AZURE_OPENAI_API_KEY: "k",
          AZURE_OPENAI_DEPLOYMENT_CHEAP: "mini-deploy",
        }),
      ),
    ).toBe(true);
  });

  it("azure models gate on their OWN deployment var independently", () => {
    const azureSmallOnly = env({
      AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_DEPLOYMENT_CHEAP: "mini-deploy",
      // STANDARD deployment intentionally absent.
    });
    expect(isModelAvailable(azureMini, azureSmallOnly)).toBe(true);
    expect(isModelAvailable(azure4o, azureSmallOnly)).toBe(false);
  });

  it("defaults to reading process.env when no env passed", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(isModelAvailable(openai)).toBe(false);
    process.env.OPENAI_API_KEY = "sk-x";
    expect(isModelAvailable(openai)).toBe(true);
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  });
});
