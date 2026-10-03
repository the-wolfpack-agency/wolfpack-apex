/**
 * escalationProviderPins - the providers the factory escalates to when the cheap
 * default cannot do a task. These MUST be pins complete() actually recognizes
 * (provider names) at a tier the provider serves - the live dogfood proved that
 * routing by models/registry id (azure-deepseek-v3) silently fell back to cheap,
 * so "escalation" re-ran gpt-4o-mini. Pure: reads only the injected env.
 */
import { escalationProviderPins } from "@/lib/ai/router";

const FOUNDRY_CHEAP = {
  AI_COMPAT_PROVIDERS: "foundry",
  AI_COMPAT_FOUNDRY_BASE_URL: "https://x.services.ai.azure.com",
  AI_COMPAT_FOUNDRY_API_KEY: "k",
  AI_COMPAT_FOUNDRY_MODEL_CHEAP: "deepseek-v3",
};

describe("escalationProviderPins", () => {
  it("emits the compatible provider NAME (not a models-registry id) at the tier it serves", () => {
    // This is the whole fix: the pin is "foundry" (what complete() matches), not
    // "azure-deepseek-v3" (what complete() ignores), and tier is the served one.
    expect(escalationProviderPins({ env: FOUNDRY_CHEAP })).toEqual([{ pin: "foundry", tier: "cheap" }]);
  });

  it("asks at the STRONGEST tier the provider serves (so supportsTier does not reject the pin)", () => {
    const env = { ...FOUNDRY_CHEAP, AI_COMPAT_FOUNDRY_MODEL_PREMIUM: "deepseek-r1" };
    expect(escalationProviderPins({ env })).toEqual([{ pin: "foundry", tier: "premium" }]);
  });

  it("appends anthropic (premium) when its key is configured", () => {
    const pins = escalationProviderPins({ env: { ...FOUNDRY_CHEAP, ANTHROPIC_API_KEY: "sk-ant" } });
    expect(pins).toContainEqual({ pin: "foundry", tier: "cheap" });
    expect(pins).toContainEqual({ pin: "anthropic", tier: "premium" });
  });

  it("excludes a pin already tried (the current executor)", () => {
    expect(escalationProviderPins({ env: FOUNDRY_CHEAP, excludePins: ["foundry", ""] })).toEqual([]);
  });

  it("NEVER offers the cheap azure default - re-running it is the no-op being fixed", () => {
    const env = { ...FOUNDRY_CHEAP, AZURE_OPENAI_ENDPOINT: "https://y.openai.azure.com", AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_DEPLOYMENT_CHEAP: "gpt-4o-mini" };
    const pins = escalationProviderPins({ env });
    expect(pins.some((p) => p.pin.includes("azure") || p.pin.includes("gpt-4o-mini"))).toBe(false);
  });

  it("returns nothing when no distinct provider is configured (honest needs_human, never a fake jump)", () => {
    expect(escalationProviderPins({ env: {} })).toEqual([]);
  });
});
