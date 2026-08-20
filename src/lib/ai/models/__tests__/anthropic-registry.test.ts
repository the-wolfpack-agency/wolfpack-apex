/**
 * Claude in the selection catalogue.
 *
 * The gateway has called Anthropic all along: anthropic-provider.ts maps every
 * tier to a model and bills against its own price table. The SELECTION
 * registry had no Anthropic entries, so "cheapest at tier" compared Azure and
 * OpenAI to each other and never to Claude. On a deployment where Anthropic is
 * the only configured provider, selection had nothing to choose, and the
 * router page reported decisions over a catalogue that excluded the model
 * actually answering.
 *
 * That is a correctness bug wearing the clothes of a missing feature, which is
 * why these tests are about agreement between two files rather than about a
 * catalogue being longer.
 */
import { MODEL_REGISTRY, isModelAvailable, getModel } from "@/lib/ai/models/registry";
import { selectModel } from "@/lib/ai/models/router";
import { ANTHROPIC_TIER_PRICING, ANTHROPIC_TIER_TO_MODEL } from "@/lib/ai/anthropic-provider";

const anthropicOnly = { ANTHROPIC_API_KEY: "k", NODE_ENV: "test" } as NodeJS.ProcessEnv;

describe("the registry describes the models the gateway actually calls", () => {
  test("every tier the provider maps has a registry entry", () => {
    /* If these fall out of step, the router page describes a catalogue the
       gateway does not use. */
    /* Collected rather than asserted one at a time: Jest's expect takes a
       single argument, so the message form (Playwright's) silently changes the
       assertion, and a list names every missing id instead of only the first. */
    const served = Object.values(ANTHROPIC_TIER_TO_MODEL);
    expect(served.filter((id) => !getModel(id))).toEqual([]);
  });

  test("registry prices come from the provider's own table, converted per-1k", () => {
    const haiku = getModel("claude-haiku-4-5");
    expect(haiku?.inputPricePer1kUsd).toBeCloseTo(ANTHROPIC_TIER_PRICING.cheap.input_per_mtok / 1000, 10);
    expect(haiku?.outputPricePer1kUsd).toBeCloseTo(ANTHROPIC_TIER_PRICING.cheap.output_per_mtok / 1000, 10);
  });
});

describe("availability follows the key", () => {
  test("present with ANTHROPIC_API_KEY, absent without it", () => {
    const opus = getModel("claude-opus-4-7")!;
    expect(isModelAvailable(opus, anthropicOnly)).toBe(true);
    expect(isModelAvailable(opus, { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("selection can now choose Claude", () => {
  test("an Anthropic-only deployment selects a real model instead of nothing", () => {
    /* The case that was broken: nothing else configured, so before this the
       catalogue offered no candidate at all. */
    const chosen = selectModel({ requiredTier: "small" }, anthropicOnly);
    expect(chosen.model.provider).toBe("anthropic");
    expect(chosen.model.id).toBe("claude-haiku-4-5");
  });

  test("a reasoning request reaches Opus rather than downgrading", () => {
    const chosen = selectModel({ requiredTier: "reasoning" }, anthropicOnly);
    expect(chosen.model.id).toBe("claude-opus-4-7");
    expect(chosen.reason).toBe("cheapest_at_tier");
  });

  test("Claude does not displace a cheaper model where one is configured", () => {
    /* Adding a provider must not quietly raise the bill: gpt-4o-mini is far
       cheaper than Haiku, so a small request still goes there. */
    const bothConfigured = {
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k",
    } as NodeJS.ProcessEnv;
    expect(selectModel({ requiredTier: "small" }, bothConfigured).model.id).toBe("gpt-4o-mini");
  });

  test("the catalogue stays internally consistent", () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.inputPricePer1kUsd).toBeGreaterThan(0);
      expect(m.outputPricePer1kUsd).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });
});
