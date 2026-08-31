/**
 * src/lib/ai/models/router - cost-aware, deterministic model selection.
 *
 * selectModel() is a PURE function of (registry + options + env): no network,
 * no analytics, no clock. Given the same inputs it always returns the same
 * decision, which makes it trivially testable and safe to call from anywhere
 * the agent runtime is about to spend tokens.
 *
 * Resolution order (each step only ever picks an AVAILABLE model):
 *   1. Pins, highest precedence first: agentPin > clientPin > workspacePin.
 *      A pin that exists AND is available wins immediately. A pin that is
 *      unknown OR unavailable does NOT hard-fail - we record fallbackFrom and
 *      fall through to cost-based selection, so a temporarily-down client pin
 *      degrades gracefully instead of blanking the call.
 *   2. Cost-based: among AVAILABLE models whose tier >= requiredTier AND whose
 *      contextWindow >= minContextTokens, pick the CHEAPEST by a blended price,
 *      tie-breaking by lower tier then by id for determinism.
 *   3. Downgrade: if nothing qualifies at the required tier, pick the cheapest
 *      AVAILABLE model of any tier (reason explains the downgrade).
 *   4. Last resort: if truly nothing is available, return the cheapest model in
 *      the registry regardless of availability, reason
 *      "no_model_available_using_default". The router NEVER throws; the caller
 *      decides what to do with an unavailable default.
 *
 * Analytics live in logModelSelection(), kept separate so selectModel stays
 * pure. Callers fire it so no routing decision is ever lost.
 */

import { trackEvent } from "@/lib/analytics";

import { isClientModel } from "./client-models";
import {
  MODEL_REGISTRY,
  TIER_ORDER,
  getModel,
  isModelAvailable,
} from "./registry";
import type {
  CapabilityTier,
  ModelSelection,
  ModelSelectionLogContext,
  ModelSpec,
  SelectOptions,
} from "./types";

/**
 * Default blend when no token estimates are supplied. Output tokens are priced
 * higher and typically fewer; a 1:1 blend is a neutral, defensible default that
 * keeps selection stable. Weights are fractions that sum to 1.
 */
const DEFAULT_INPUT_WEIGHT = 0.5;
const DEFAULT_OUTPUT_WEIGHT = 0.5;

/**
 * Estimated USD cost of a call on `model` for the given token counts. Pure.
 * Prices are per 1k tokens, so divide token counts by 1000.
 */
export function estimateCostUsd(
  model: ModelSpec,
  inTokens: number,
  outTokens: number,
): number {
  const inK = Math.max(0, inTokens) / 1000;
  const outK = Math.max(0, outTokens) / 1000;
  return inK * model.inputPricePer1kUsd + outK * model.outputPricePer1kUsd;
}

/**
 * Blended per-call price used to rank candidates. When token estimates are
 * given we use the real estimated cost (so a model that is cheap on input but
 * pricey on output ranks correctly for an output-heavy call). Otherwise we fall
 * back to a fixed-weight blend of the per-1k prices.
 */
function blendedPrice(model: ModelSpec, opts: SelectOptions): number {
  const hasEstimate =
    typeof opts.estInputTokens === "number" ||
    typeof opts.estOutputTokens === "number";
  if (hasEstimate) {
    return estimateCostUsd(
      model,
      opts.estInputTokens ?? 0,
      opts.estOutputTokens ?? 0,
    );
  }
  return (
    DEFAULT_INPUT_WEIGHT * model.inputPricePer1kUsd +
    DEFAULT_OUTPUT_WEIGHT * model.outputPricePer1kUsd
  );
}

/**
 * Deterministic comparator: cheapest blended price first, then lower tier, then
 * id ascending. The tie-breaks guarantee identical inputs always pick the same
 * model regardless of registry array order or platform sort stability.
 */
function cheaperFirst(
  a: ModelSpec,
  b: ModelSpec,
  opts: SelectOptions,
): number {
  const pa = blendedPrice(a, opts);
  const pb = blendedPrice(b, opts);
  if (pa !== pb) return pa - pb;
  const ta = TIER_ORDER[a.capabilityTier];
  const tb = TIER_ORDER[b.capabilityTier];
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Cheapest of a list under the blended-price comparator, or undefined. */
function cheapest(
  models: readonly ModelSpec[],
  opts: SelectOptions,
): ModelSpec | undefined {
  if (models.length === 0) return undefined;
  return [...models].sort((a, b) => cheaperFirst(a, b, opts))[0];
}

/** Attach an estimated cost to a selection when token estimates were given. */
function withEstimate(
  selection: ModelSelection,
  opts: SelectOptions,
): ModelSelection {
  const hasEstimate =
    typeof opts.estInputTokens === "number" ||
    typeof opts.estOutputTokens === "number";
  if (!hasEstimate) return selection;
  return {
    ...selection,
    estimatedCostUsd: estimateCostUsd(
      selection.model,
      opts.estInputTokens ?? 0,
      opts.estOutputTokens ?? 0,
    ),
  };
}

/**
 * Resolve the first usable pin in precedence order. Returns the available
 * pinned model plus the reason, OR a fallbackFrom marker for the first pin that
 * was set-but-unusable so the caller can see what we degraded away from.
 */
function resolvePins(
  opts: SelectOptions,
  env: NodeJS.ProcessEnv,
  catalog: readonly ModelSpec[],
): { model?: ModelSpec; reason?: string; fallbackFrom?: string } {
  const pins: { id: string | undefined; reason: string }[] = [
    { id: opts.agentPin, reason: "agent_pin" },
    { id: opts.clientPin, reason: "client_pin" },
    { id: opts.workspacePin, reason: "workspace_pin" },
  ];

  let firstUnusable: string | undefined;
  for (const pin of pins) {
    if (!pin.id) continue;
    // Look in the CATALOG, not just the Wolfpack registry: a client that has
    // plugged in their own model must be able to pin it, or "bring your own
    // model" means "bring your own model and never have it chosen".
    const model = catalog.find((m) => m.id === pin.id) ?? getModel(pin.id);
    if (model && (isClientModel(model) || isModelAvailable(model, env))) {
      return { model, reason: pin.reason };
    }
    // Pin set but unknown or unavailable: remember the highest-precedence one
    // we degraded from, then keep looking / fall through to cost-based.
    if (firstUnusable === undefined) firstUnusable = pin.id;
  }
  return { fallbackFrom: firstUnusable };
}

/**
 * Pick the best-priced capable, available model. Pure + deterministic.
 *
 * @param opts selection constraints + pins + token estimates.
 * @param env  injectable environment (defaults to process.env). Tests pass a
 *             fake object so availability is hermetic.
 */
/**
 * The models this decision may choose from.
 *
 * Defaults to the Wolfpack registry, so every existing caller is unchanged. A
 * caller serving a client that has plugged in their own models passes the
 * merged catalog instead — and everything downstream (the gate, the
 * containment budget, the behavior eval, the audit trail) applies identically,
 * because none of it knows or cares where a model came from. That is the point:
 * a control that only works on our own models is not a control.
 */
export function selectModel(
  opts: SelectOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  catalog: readonly ModelSpec[] = MODEL_REGISTRY,
): ModelSelection {
  const requiredTier: CapabilityTier = opts.requiredTier ?? "small";
  const minContext = opts.minContextTokens ?? 0;

  // Step 1: pins.
  const pin = resolvePins(opts, env, catalog);
  if (pin.model && pin.reason) {
    return withEstimate({ model: pin.model, reason: pin.reason }, opts);
  }
  const fallbackFrom = pin.fallbackFrom;

  // A client model is available when its config is present; there is no env var
  // to check because it was not deployed by us.
  const available = catalog.filter((m) => isClientModel(m) || isModelAvailable(m, env));

  // Step 2: cost-based among capable + context-fitting + available.
  const capable = available.filter(
    (m) =>
      TIER_ORDER[m.capabilityTier] >= TIER_ORDER[requiredTier] &&
      m.contextWindow >= minContext,
  );
  const best = cheapest(capable, opts);
  if (best) {
    return withEstimate(
      {
        model: best,
        reason: "cheapest_at_tier",
        ...(fallbackFrom ? { fallbackFrom } : {}),
      },
      opts,
    );
  }

  /* Step 3: downgrade to the MOST CAPABLE available, not the cheapest.
   *
   * THE BUG THIS FIXES. This took the cheapest model of ANY tier, so a request
   * that could not be served at its tier fell all the way to the floor. Asking
   * for "reasoning" with no reasoning model available returned gpt-4o-mini,
   * the smallest model on the board: the maximum possible distance from what
   * was asked, chosen deliberately.
   *
   * Measured in production over sixty days: 5 premium requests and 82 standard
   * requests were served by gpt-4o-mini. The premium ones cost $0.135 across 5
   * calls, the highest per-call cost recorded, for the least capable answer
   * available. Somebody asked for the best model, waited longer, paid more,
   * and got the smallest.
   *
   * A downgrade should step DOWN one rung at a time. If reasoning is
   * unavailable but large is, large is the honest answer: it is the closest
   * thing to what was requested. Cost still breaks ties WITHIN the best
   * available tier, so this does not spend more than it must.
   *
   * Reported as a downgrade either way, so the caller can see it did not get
   * what it asked for. */
  const anyTier = available.filter((m) => m.contextWindow >= minContext);
  const pool = anyTier.length > 0 ? anyTier : available;
  const bestTierAvailable = pool.reduce<number>(
    (top, m) => Math.max(top, TIER_ORDER[m.capabilityTier]),
    -1,
  );
  const downgraded =
    bestTierAvailable >= 0
      ? cheapest(
          pool.filter((m) => TIER_ORDER[m.capabilityTier] === bestTierAvailable),
          opts,
        )
      : undefined;
  if (downgraded) {
    return withEstimate(
      {
        model: downgraded,
        reason: "downgraded_no_tier_available",
        ...(fallbackFrom ? { fallbackFrom } : {}),
      },
      opts,
    );
  }

  // Step 4: nothing available anywhere - return the cheapest registry model
  // regardless of availability. Never throw; the caller decides.
  const last = cheapest(catalog, opts) ?? cheapest(MODEL_REGISTRY, opts)!;
  return withEstimate(
    {
      model: last,
      reason: "no_model_available_using_default",
      ...(fallbackFrom ? { fallbackFrom } : {}),
    },
    opts,
  );
}

/**
 * Record a selection to analytics so no routing decision is lost. Kept out of
 * selectModel() to preserve purity - callers invoke this once they decide to
 * spend tokens on the chosen model.
 *
 * Emits "ai.model_selected" always, and additionally "ai.model_fallback" when
 * the selection degraded away from a pin (fallbackFrom set), so dashboards can
 * count graceful degradations independently.
 */
export function logModelSelection(
  selection: ModelSelection,
  ctx: ModelSelectionLogContext,
): void {
  const base: Record<string, string | number | boolean> = {
    model_id: selection.model.id,
    provider: selection.model.provider,
    tier: selection.model.capabilityTier,
    reason: selection.reason,
    ...(typeof selection.estimatedCostUsd === "number"
      ? { estimated_cost_usd: selection.estimatedCostUsd }
      : {}),
    ...(selection.fallbackFrom ? { fallback_from: selection.fallbackFrom } : {}),
    ...(ctx.extra ?? {}),
  };

  trackEvent("ai.model_selected", ctx.userId, ctx.userRole, base);

  if (selection.fallbackFrom) {
    trackEvent("ai.model_fallback", ctx.userId, ctx.userRole, base);
  }
}
