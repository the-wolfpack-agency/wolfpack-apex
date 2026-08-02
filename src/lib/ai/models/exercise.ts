/**
 * Proving the router actually switches, rather than assuming it does.
 *
 * WHAT THE EXISTING TESTS DO AND DO NOT PROVE
 *
 * router.test.ts proves the selection rules against a fake environment.
 * router-integration.test.ts proves the executor is genuinely on the router's
 * path. Neither proves the thing that matters in production: that with several
 * real models deployed, the router moves between them correctly and picks the
 * cheapest capable one every time.
 *
 * That cannot be settled by a unit test, because it is a claim about a
 * DEPLOYMENT. So this runs the real selectModel against the real environment
 * and reports what actually happened.
 *
 * THE FAILURE THIS IS DESIGNED TO PREVENT
 *
 * With one model configured, every scenario selects it and every scenario
 * "passes". A report of ten green ticks would then be read as "switching
 * works", when what it showed was a router with no choice to make. So the
 * result carries `switchingProven`, which is false unless the run actually
 * observed the router choose DIFFERENT models for different requirements.
 *
 * Pure: the environment is injected, so the same code proves the harness in CI
 * and proves the deployment when run against production.
 */
import { selectModel } from "./router";
import { MODEL_REGISTRY, isModelAvailable } from "./registry";
import type { CapabilityTier, ModelSpec, SelectOptions } from "./types";

export interface Scenario {
  name: string;
  /** What a caller would ask for. */
  opts: SelectOptions;
  /** What the scenario is testing, in one line. */
  intent: string;
}

/**
 * The scenarios worth running, chosen to exercise each decision the router can
 * make rather than to produce a long list.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: "cheap work",
    opts: { requiredTier: "small", estInputTokens: 1000, estOutputTokens: 200 },
    intent: "A small task should take the cheapest small-tier model, not a large one.",
  },
  {
    name: "capable work",
    opts: { requiredTier: "large", estInputTokens: 4000, estOutputTokens: 1000 },
    intent: "A large-tier requirement must not be served by a small model.",
  },
  {
    name: "reasoning work",
    opts: { requiredTier: "reasoning", estInputTokens: 2000, estOutputTokens: 2000 },
    intent: "A reasoning requirement takes an o-series model, or honestly downgrades.",
  },
  {
    name: "long context",
    opts: { requiredTier: "small", minContextTokens: 100_000 },
    intent: "A context requirement filters out models whose window is too small.",
  },
  {
    name: "agent pin honoured",
    opts: { agentPin: "azure-gpt-4o" },
    intent: "An explicit pin beats cost.",
  },
  {
    name: "pin that does not exist",
    opts: { agentPin: "not-a-real-model" },
    intent: "An unusable pin degrades to cost-based selection and records what it degraded from.",
  },
];

export interface ScenarioResult {
  scenario: string;
  intent: string;
  modelId: string;
  provider: string;
  tier: CapabilityTier;
  reason: string;
  estimatedCostUsd: number | null;
  fallbackFrom: string | null;
  /** Set when the router did something the scenario says it should not. */
  problem: string | null;
}

export interface ExerciseReport {
  availableModels: { id: string; tier: CapabilityTier; provider: string }[];
  results: ScenarioResult[];
  /**
   * True only when the run observed the router select MORE THAN ONE model.
   * With a single model configured every scenario picks it and every check
   * passes, which proves the router has no choice rather than that it chooses
   * well.
   */
  switchingProven: boolean;
  /** Distinct models actually selected across the run. */
  modelsUsed: string[];
  problems: string[];
  headline: string;
}

const TIER_ORDER: Record<CapabilityTier, number> = { small: 0, large: 1, reasoning: 2 };

/**
 * Reasons that are the router HONESTLY reporting it could not meet the ask.
 *
 * Both must be excused from the tier and context checks. Flagging them would
 * make a correctly-behaving router look broken in an unconfigured environment —
 * which is the state every developer machine is in, so the harness would cry
 * wolf on its very first run and be ignored by its second.
 */
const HONEST_SHORTFALL = new Set(["downgraded_no_tier_available", "no_model_available_using_default"]);

/** Did the router do something this scenario says it must not? */
function checkScenario(scenario: Scenario, model: ModelSpec, reason: string): string | null {
  const required = scenario.opts.requiredTier;
  if (required && TIER_ORDER[model.capabilityTier] < TIER_ORDER[required] && !HONEST_SHORTFALL.has(reason)) {
    return `asked for ${required}, got ${model.capabilityTier} with reason '${reason}' rather than an honest downgrade`;
  }
  const minContext = scenario.opts.minContextTokens;
  if (minContext && model.contextWindow < minContext && !HONEST_SHORTFALL.has(reason)) {
    return `asked for ${minContext} context, got a ${model.contextWindow} window`;
  }
  if (scenario.opts.agentPin && scenario.opts.agentPin === model.id && reason !== "agent_pin") {
    return `pinned model was chosen but the reason was '${reason}' rather than 'agent_pin'`;
  }
  return null;
}

export function runExercise(env: NodeJS.ProcessEnv = process.env): ExerciseReport {
  const available = MODEL_REGISTRY.filter((m) => isModelAvailable(m, env));

  const results: ScenarioResult[] = SCENARIOS.map((scenario) => {
    const decision = selectModel(scenario.opts, env);
    return {
      scenario: scenario.name,
      intent: scenario.intent,
      modelId: decision.model.id,
      provider: decision.model.provider,
      tier: decision.model.capabilityTier,
      reason: decision.reason,
      estimatedCostUsd: decision.estimatedCostUsd ?? null,
      fallbackFrom: decision.fallbackFrom ?? null,
      problem: checkScenario(scenario, decision.model, decision.reason),
    };
  });

  const modelsUsed = [...new Set(results.map((r) => r.modelId))].sort();
  const problems = results.filter((r) => r.problem).map((r) => `${r.scenario}: ${r.problem}`);
  const switchingProven = modelsUsed.length > 1;

  let headline: string;
  if (available.length === 0) {
    headline =
      "No models are configured in this environment, so the router had nothing to choose from. Every scenario fell back to a default. This proves nothing about switching.";
  } else if (!switchingProven) {
    headline = `Only ${available.length} model is available (${available.map((m) => m.id).join(", ")}), so every scenario selected the same one. The checks passed, but they proved the router had no choice rather than that it chooses well. Configure a second model at a different tier to prove switching.`;
  } else if (problems.length > 0) {
    headline = `The router switched between ${modelsUsed.length} models, but ${problems.length} scenario${problems.length === 1 ? "" : "s"} behaved incorrectly.`;
  } else {
    headline = `The router switched between ${modelsUsed.length} models across ${results.length} scenarios and every one behaved correctly.`;
  }

  return {
    availableModels: available.map((m) => ({ id: m.id, tier: m.capabilityTier, provider: m.provider })),
    results,
    switchingProven,
    modelsUsed,
    problems,
    headline,
  };
}

/**
 * What to set to prove switching, given what is already set.
 *
 * Returned as data rather than printed so the same guidance can appear in a CLI
 * run and on an admin page without the two drifting.
 */
export function missingConfigForSwitching(env: NodeJS.ProcessEnv = process.env): string[] {
  const available = MODEL_REGISTRY.filter((m) => isModelAvailable(m, env));
  const tiers = new Set(available.map((m) => m.capabilityTier));
  const steps: string[] = [];

  const azureBase = Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY);
  if (!azureBase && !env.OPENAI_API_KEY) {
    steps.push(
      "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY (or OPENAI_API_KEY) — no provider is configured at all.",
    );
  }
  if (azureBase && !env.AZURE_OPENAI_DEPLOYMENT_CHEAP) {
    steps.push(
      "Create a gpt-4o-mini deployment in your Azure OpenAI resource and set AZURE_OPENAI_DEPLOYMENT_CHEAP to its deployment name — this gives the router a cheap small-tier option.",
    );
  }
  if (azureBase && !env.AZURE_OPENAI_DEPLOYMENT_STANDARD) {
    steps.push(
      "Create a gpt-4o deployment and set AZURE_OPENAI_DEPLOYMENT_STANDARD to its deployment name — this gives the router a large-tier option to switch UP to.",
    );
  }
  if (tiers.size < 2 && steps.length === 0) {
    steps.push("Two models are configured but at the same tier; the router needs models at different tiers to switch between.");
  }
  return steps;
}
