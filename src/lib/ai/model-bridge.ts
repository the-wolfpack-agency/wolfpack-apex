/**
 * Making the router that CHOOSES a model and the router that CALLS one agree.
 *
 * THE PROBLEM THIS FIXES
 *
 * There are two routers and they have never spoken to each other.
 *
 *   lib/ai/models/router.ts  selects a ModelSpec by tier, cost and pins, and
 *                            emits ai.model_selected. Called by the executor.
 *   lib/ai/router.ts         picks a PROVIDER by environment and failover, and
 *                            emits ai.completion. Called by everything that
 *                            actually makes a completion.
 *
 * So the executor records "we chose azure-gpt-4o", the completion independently
 * decides Azure or Anthropic, and the /admin/ai-router page reports the first
 * while the second is what ran. The cost figures on that page are computed from
 * the price list of a model that may not have done the work.
 *
 * That is a surface reporting on something it does not govern, and it is mine
 * from #228. This is the bridge.
 *
 * WHY THE VOCABULARIES DIFFER, AND WHY THAT IS NOT COSMETIC
 *
 * Execution speaks cheap/standard/premium — a COST posture, chosen by the
 * caller. Selection speaks small/large/reasoning — a CAPABILITY floor, a
 * statement about what the task needs. They are genuinely different questions
 * that happened to be answered by two systems, and mapping them is where the
 * two designs meet rather than a rename.
 *
 * SAFETY: THIS CANNOT CHANGE TODAY'S BEHAVIOUR
 *
 * Every AI call in the platform goes through the execution router. A bridge
 * that got this wrong would not degrade one feature, it would break all of
 * them. So it only ever REFINES: when selection names a provider that is
 * configured and supports the tier, that provider is used; in every other case
 * it returns null and the existing logic runs untouched. There is no path where
 * this makes a call fail that would otherwise have succeeded.
 */
import { selectModel } from "@/lib/ai/models/router";
import { isClientModel } from "@/lib/ai/models/client-models";
import type { ModelSpec, CapabilityTier } from "@/lib/ai/models/types";
import type { AIModelTier, AIProvider } from "./types";

/**
 * Cost posture to capability floor.
 *
 * premium maps to `reasoning` rather than to `large`, because a caller asking
 * for premium is asking for the most capable thing available and the selection
 * router treats a tier as a FLOOR — a reasoning model satisfies a request for
 * large, so nothing is lost, while the reverse would silently under-serve.
 */
export function capabilityTierFor(tier: AIModelTier): CapabilityTier {
  switch (tier) {
    case "cheap":
      return "small";
    case "premium":
      return "reasoning";
    default:
      return "large";
  }
}

/** The providers the execution router can actually call. */
export interface ProviderLookup {
  azure: AIProvider;
  anthropic: AIProvider;
}

export interface BridgedChoice {
  spec: ModelSpec;
  provider: AIProvider;
}

/**
 * Which provider should serve this request, according to the selection router?
 *
 * Returns null whenever selection cannot improve on the existing logic, and the
 * caller then behaves exactly as it does today. Specifically null when:
 *
 *   - selection had nothing available and fell back to a registry default. Its
 *     answer carries no information, and acting on it would send traffic at a
 *     provider that is not configured.
 *   - the named provider does not support this tier, or is not wired up here.
 *   - the model is client-supplied. Those have their own endpoint and are not
 *     reachable through the two providers this router knows how to call, so
 *     pretending otherwise would route a client's traffic to OUR Azure resource
 *     — which is a data-handling incident, not a routing bug.
 */
export function bridgeSelection(
  tier: AIModelTier,
  providers: ProviderLookup,
  deps: { select?: typeof selectModel; env?: NodeJS.ProcessEnv } = {},
): BridgedChoice | null {
  const select = deps.select ?? selectModel;
  const decision = select({ requiredTier: capabilityTierFor(tier) }, deps.env ?? process.env);

  // Selection had no real choice. Its answer is a placeholder, not a decision.
  if (decision.reason === "no_model_available_using_default") return null;

  // A client's own model is served from a client endpoint. Routing it through
  // our Azure resource would send their prompt to our tenant.
  if (isClientModel(decision.model)) return null;

  const provider = decision.model.provider === "azure" ? providers.azure : providers.anthropic;
  if (!provider) return null;
  if (!provider.supportsTier(tier)) return null;

  return { spec: decision.model, provider };
}
