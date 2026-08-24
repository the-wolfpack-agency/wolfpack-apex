/**
 * A model we do not own.
 *
 * The registry could always DESCRIBE one: client-models.ts validates an
 * endpoint somebody types, namespaces the id so a client cannot shadow
 * ours, and marks the price declared rather than verified. All tested,
 * and none of it connected.
 *
 * "openai" here is a WIRE FORMAT, not a vendor. Kimi, Qwen, vLLM, Ollama
 * and most gateways speak /chat/completions, and every model a client
 * brings arrives under that provider carrying the endpoint it is really
 * served from. Two places assumed the word meant OpenAI the company.
 */

export {};

import { probeTargetFor } from "../probe";
import { isModelAvailable } from "../registry";
import type { ModelSpec } from "../types";

/** What client-models.ts produces, minus the parts these two never read. */
const KIMI = {
  id: "client:kimi-k2",
  provider: "openai",
  capabilityTier: "large",
  contextWindow: 128_000,
  inputPricePer1kUsd: 0.00058,
  outputPricePer1kUsd: 0.00232,
  endpoint: "https://api.moonshot.cn/v1/chat/completions",
  apiKeyEnvVar: "KIMI_API_KEY",
} as unknown as ModelSpec;

const PLAIN_OPENAI = {
  id: "gpt-4o-mini",
  provider: "openai",
  capabilityTier: "small",
  contextWindow: 128_000,
  inputPricePer1kUsd: 0.00015,
  outputPricePer1kUsd: 0.0006,
} as unknown as ModelSpec;

describe("where a third-party model is probed", () => {
  it("goes to the host it is actually served from", () => {
    /* It went to api.openai.com. A client's own model would have been
       probed against somebody else's host, with a key that does not
       belong there, and reported unreachable for a reason that had
       nothing to do with their deployment. */
    expect(probeTargetFor(KIMI, {} as NodeJS.ProcessEnv)?.url).toBe(
      "https://api.moonshot.cn/v1/chat/completions",
    );
  });

  it("still goes to OpenAI for a model that has no endpoint of its own", () => {
    expect(probeTargetFor(PLAIN_OPENAI, {} as NodeJS.ProcessEnv)?.url).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });
});

describe("whether a third-party model counts as available", () => {
  it("asks for the key that model needs", () => {
    expect(isModelAvailable(KIMI, { KIMI_API_KEY: "k" })).toBe(true);
  });

  it("is not made available by an unrelated OpenAI key", () => {
    /* The failure in the other direction, and the worse one: reported
       available because we hold a credential for a different company. The
       azure branch has had this reasoning in a comment for months; this
       branch never got it. */
    expect(isModelAvailable(KIMI, { OPENAI_API_KEY: "sk-not-theirs" })).toBe(false);
  });

  it("is not made unavailable by our OpenAI key being absent", () => {
    expect(isModelAvailable(KIMI, { KIMI_API_KEY: "k", OPENAI_API_KEY: "" })).toBe(true);
  });

  it("leaves a plain OpenAI model keyed on OPENAI_API_KEY", () => {
    expect(isModelAvailable(PLAIN_OPENAI, { OPENAI_API_KEY: "sk-ours" })).toBe(true);
    expect(isModelAvailable(PLAIN_OPENAI, {})).toBe(false);
  });
});
