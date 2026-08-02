/**
 * Making the two routers agree, without letting the bridge break anything.
 *
 * Every AI call in the platform goes through the execution router. A bridge
 * that got this wrong would not degrade one feature, it would break all of
 * them — so most of these tests are about the cases where it must decline to
 * act and let the existing logic run.
 */
import { bridgeSelection, capabilityTierFor } from "../model-bridge";
import type { AIProvider } from "../types";
import type { ModelSelection } from "@/lib/ai/models/types";

const provider = (name: string, tiers: string[]): AIProvider => ({
  name,
  supportsTier: (t: string) => tiers.includes(t),
  complete: jest.fn(),
});

const registry = () => ({
  azure: provider("azure-openai", ["cheap", "standard", "premium"]),
  anthropic: provider("anthropic", ["cheap", "standard", "premium"]),
});

const selection = (over: Partial<ModelSelection> = {}): ModelSelection =>
  ({
    model: {
      id: "azure-gpt-4o",
      provider: "azure",
      capabilityTier: "large",
      contextWindow: 128000,
      inputPricePer1kUsd: 0.005,
      outputPricePer1kUsd: 0.015,
    },
    reason: "cheapest_at_tier",
    ...over,
  }) as ModelSelection;

describe("cost posture maps to capability floor", () => {
  it("maps premium to reasoning, not large", () => {
    // A tier is a FLOOR in the selection router: a reasoning model satisfies a
    // request for large, so nothing is lost. Mapping premium to large would
    // silently under-serve the caller who asked for the most capable thing.
    expect(capabilityTierFor("premium")).toBe("reasoning");
    expect(capabilityTierFor("cheap")).toBe("small");
    expect(capabilityTierFor("standard")).toBe("large");
  });
});

describe("it refines, and otherwise declines", () => {
  it("returns the provider selection named", () => {
    const bridged = bridgeSelection("standard", registry(), { select: () => selection() });
    expect(bridged?.provider.name).toBe("azure-openai");
    expect(bridged?.spec.id).toBe("azure-gpt-4o");
  });

  it("routes an openai-provider model to anthropic's slot only when that is the wiring", () => {
    // The execution router knows two providers. A selection naming something
    // else must not be forced into the wrong one.
    const bridged = bridgeSelection("standard", registry(), {
      select: () => selection({ model: { ...selection().model, provider: "openai" } }),
    });
    expect(bridged?.provider.name).toBe("anthropic");
  });

  it("DECLINES when selection had no real choice", () => {
    // no_model_available_using_default is a placeholder, not a decision. Acting
    // on it would send traffic at a provider that is not configured.
    const bridged = bridgeSelection("standard", registry(), {
      select: () => selection({ reason: "no_model_available_using_default" }),
    });
    expect(bridged).toBeNull();
  });

  it("DECLINES for a client-supplied model", () => {
    // The most important refusal here. A client's model has its own endpoint;
    // routing it through OUR Azure resource would send their prompt into our
    // tenant, which is a data-handling incident rather than a routing bug.
    const bridged = bridgeSelection("standard", registry(), {
      select: () =>
        selection({
          model: {
            ...selection().model,
            id: "client:acme-llm",
            origin: "client",
            endpoint: "https://llm.acme.example.com/v1",
            label: "Acme",
            priceDeclaredByClient: true,
          } as never,
        }),
    });
    expect(bridged).toBeNull();
  });

  it("DECLINES when the named provider does not support the tier", () => {
    const reg = { azure: provider("azure-openai", ["cheap"]), anthropic: provider("anthropic", ["cheap"]) };
    const bridged = bridgeSelection("premium", reg, { select: () => selection() });
    expect(bridged).toBeNull();
  });

  it("never throws, whatever selection returns", () => {
    // This sits in front of every AI call in the platform.
    expect(() =>
      bridgeSelection("standard", registry(), {
        select: () => selection({ model: { ...selection().model, provider: "something-new" } as never }),
      }),
    ).not.toThrow();
  });
});

describe("what this fixes", () => {
  it("gives the completion event the id selection actually chose", () => {
    // The reported model and the executed model came from two independent
    // decisions before this, so /admin/ai-router could show a model that never
    // ran, with cost computed from its price list.
    const bridged = bridgeSelection("cheap", registry(), {
      select: () => selection({ model: { ...selection().model, id: "azure-gpt-4o-mini", capabilityTier: "small" } }),
    });
    expect(bridged?.spec.id).toBe("azure-gpt-4o-mini");
  });
});
