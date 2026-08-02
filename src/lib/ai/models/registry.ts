/**
 * src/lib/ai/models/registry - the frozen, named model registry.
 *
 * Mirrors src/lib/crypto/algorithms.ts: a single source of truth keyed by id,
 * with pure resolvers and no behavior beyond lookup + env-gated availability.
 * Adding, repricing, or retiring a model is a single edit here, never a call-
 * site refactor (model agility).
 *
 * ============================================================================
 * PRICES ARE LIST PRICES (USD per 1k tokens) AS OF AUTHORING (2026-06).
 * UPDATE THEM HERE ONLY. Do not scatter prices across call sites. When a
 * billing/pricing service lands, this table becomes its cache, not a fork.
 * ============================================================================
 *
 * Availability is env-gated, never hard-coded:
 *   - OpenAI models require OPENAI_API_KEY.
 *   - Azure models require AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY, plus
 *     the model's own deploymentEnvVar (the per-resource deployment name)
 *     when one is declared.
 * No secrets live in this file; we only read presence of env vars.
 */

import type { CapabilityTier, ModelSpec } from "./types";

/* ----------------------------------------------------------------------------
 * Named price constants, USD per 1k tokens. Grouped by model family so a
 * repricing diff reads cleanly. These are the ONLY place prices are written.
 * -------------------------------------------------------------------------- */

// OpenAI gpt-4o-mini (small tier).
const GPT_4O_MINI_INPUT_PER_1K = 0.00015;
const GPT_4O_MINI_OUTPUT_PER_1K = 0.0006;

// OpenAI gpt-4o (large tier).
const GPT_4O_INPUT_PER_1K = 0.0025;
const GPT_4O_OUTPUT_PER_1K = 0.01;

// OpenAI o4-mini (reasoning tier - cheaper o-series).
const O4_MINI_INPUT_PER_1K = 0.0011;
const O4_MINI_OUTPUT_PER_1K = 0.0044;

// Azure mirrors of the same base models. Azure list prices track OpenAI's for
// these families today; kept as distinct constants so they can diverge without
// touching the OpenAI rows.
const AZURE_GPT_4O_MINI_INPUT_PER_1K = 0.00015;
const AZURE_GPT_4O_MINI_OUTPUT_PER_1K = 0.0006;

const AZURE_GPT_4O_INPUT_PER_1K = 0.0025;
const AZURE_GPT_4O_OUTPUT_PER_1K = 0.01;

/* Context windows (tokens). Named so a window bump is a one-line edit. */
const WINDOW_128K = 128_000;
const WINDOW_200K = 200_000;

/**
 * The registry. Frozen so it cannot be mutated at runtime (parity with
 * ALGORITHMS in the crypto registry). Order is intentional: cheapest-first
 * within a tier, which keeps the router's deterministic tie-breaks readable.
 */
export const MODEL_REGISTRY: readonly ModelSpec[] = Object.freeze([
  // --- small tier ---------------------------------------------------------
  {
    id: "gpt-4o-mini",
    provider: "openai",
    capabilityTier: "small",
    contextWindow: WINDOW_128K,
    inputPricePer1kUsd: GPT_4O_MINI_INPUT_PER_1K,
    outputPricePer1kUsd: GPT_4O_MINI_OUTPUT_PER_1K,
  },
  {
    id: "azure-gpt-4o-mini",
    provider: "azure",
    deploymentEnvVar: "AZURE_OPENAI_DEPLOYMENT_CHEAP",
    capabilityTier: "small",
    contextWindow: WINDOW_128K,
    inputPricePer1kUsd: AZURE_GPT_4O_MINI_INPUT_PER_1K,
    outputPricePer1kUsd: AZURE_GPT_4O_MINI_OUTPUT_PER_1K,
  },
  // --- large tier ---------------------------------------------------------
  {
    id: "gpt-4o",
    provider: "openai",
    capabilityTier: "large",
    contextWindow: WINDOW_128K,
    inputPricePer1kUsd: GPT_4O_INPUT_PER_1K,
    outputPricePer1kUsd: GPT_4O_OUTPUT_PER_1K,
  },
  {
    id: "azure-gpt-4o",
    provider: "azure",
    deploymentEnvVar: "AZURE_OPENAI_DEPLOYMENT_STANDARD",
    capabilityTier: "large",
    contextWindow: WINDOW_128K,
    inputPricePer1kUsd: AZURE_GPT_4O_INPUT_PER_1K,
    outputPricePer1kUsd: AZURE_GPT_4O_OUTPUT_PER_1K,
  },
  // --- reasoning tier -----------------------------------------------------
  {
    id: "o4-mini",
    provider: "openai",
    capabilityTier: "reasoning",
    contextWindow: WINDOW_200K,
    inputPricePer1kUsd: O4_MINI_INPUT_PER_1K,
    outputPricePer1kUsd: O4_MINI_OUTPUT_PER_1K,
  },
]);

/** Ordinal for capability tiers so "small < large < reasoning" is comparable. */
export const TIER_ORDER: Record<CapabilityTier, number> = {
  small: 0,
  large: 1,
  reasoning: 2,
};

/** Look up a model by id. Returns undefined for unknown ids (no throw). */
export function getModel(id: string): ModelSpec | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** All registered models, in registry order. Read-only. */
export function listModels(): readonly ModelSpec[] {
  return MODEL_REGISTRY;
}

/**
 * Whether a model is usable in the given environment. Pure: reads only env-var
 * presence (never values), never the network.
 *
 *   openai → OPENAI_API_KEY present.
 *   azure  → AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY present, AND the
 *            model's deploymentEnvVar (if declared) present.
 *
 * `env` is injectable so tests pass a fake env object and stay hermetic.
 */
export function isModelAvailable(
  spec: ModelSpec,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (spec.provider) {
    case "openai":
      return hasValue(env.OPENAI_API_KEY);
    case "azure": {
      const base =
        hasValue(env.AZURE_OPENAI_ENDPOINT) &&
        hasValue(env.AZURE_OPENAI_API_KEY);
      if (!base) return false;
      if (spec.deploymentEnvVar) {
        return hasValue(env[spec.deploymentEnvVar]);
      }
      return true;
    }
    default: {
      // Exhaustiveness guard: if a new provider is added to the union without
      // a branch above, TS flags this line at compile time. At runtime we fail
      // closed (not available).
      const _never: never = spec.provider;
      return Boolean(_never) && false;
    }
  }
}

/**
 * A configured value, and not a placeholder standing in for one.
 *
 * `vercel env pull` writes "[SENSITIVE]" for every variable marked sensitive —
 * which AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY both are. A plain
 * non-empty check reads that as configured, so running the router exercise
 * against a pulled .env would report models as AVAILABLE and print
 * "switching proven: YES" on the strength of literal placeholder text.
 *
 * That is the exact false confidence the exercise exists to prevent, produced
 * by the exercise itself. Placeholders are treated as unset.
 */
const PLACEHOLDERS = new Set(["[sensitive]", "[redacted]", "changeme", "todo", "xxx", "your-key-here"]);

function hasValue(v: string | undefined): boolean {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  return !PLACEHOLDERS.has(trimmed.toLowerCase());
}
