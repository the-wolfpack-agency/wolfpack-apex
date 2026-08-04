/**
 * src/lib/ai/router — single entry point for AI completions.
 *
 * Routing rules:
 *   - When Azure OpenAI is configured (AZURE_OPENAI_ENDPOINT +
 *     AZURE_OPENAI_API_KEY) and the Azure provider supportsTier(tier)
 *     returns true, Azure is the primary and Anthropic is the failover.
 *     This matches the goal of using Azure's free credits as the
 *     default path while keeping Anthropic warm as a hedge.
 *   - When Azure is not configured, Anthropic is primary and there is
 *     no failover.
 *   - The AI_PROVIDER_PRIMARY env var ('anthropic' | 'azure-openai' |
 *     'auto') pins the primary regardless of detection. Default 'auto'
 *     uses the rules above.
 *
 * Failover:
 *   - On 5xx-class errors from the primary, fall back to the other
 *     provider when one is available. Track the fallback in analytics
 *     and on the response (`provider_used`).
 *   - If no fallback is available the original error propagates to the
 *     caller; `console.warn` records the failure.
 *
 * Cost tracking:
 *   - Every successful call emits `ai.completion` to the analytics
 *     pipeline. trackEvent is fire-and-forget and never blocks.
 */

import { trackEvent } from "@/lib/analytics";
import { bridgeSelection, capabilityTierFor } from "./model-bridge";
import { selectModel, logModelSelection } from "@/lib/ai/models";
import { applyConstitutionToRequest } from "@/lib/constitution";
import { getObsClient } from "@/lib/obs";

import { AnthropicProvider } from "./anthropic-provider";
import {
  AzureOpenAIProvider,
  isAzureConfigured,
} from "./azure-openai-provider";
import type {
  AIClient,
  AICompleteRequest,
  AICompleteResponse,
  AIProvider,
} from "./types";
import { BudgetExceededError, NoProviderAvailableError } from "./types";
import {
  isOverBudget,
  loadWorkspacePolicy,
  monthSpendUsd,
  type WorkspaceAIPolicy,
} from "./workspace-policy";

interface ProviderRegistry {
  anthropic: AIProvider;
  azure: AIProvider;
}

function buildRegistry(): ProviderRegistry {
  return {
    anthropic: new AnthropicProvider(),
    azure: new AzureOpenAIProvider(),
  };
}

type PrimaryOverride = "anthropic" | "azure-openai" | "auto";

function readPrimaryOverride(): PrimaryOverride {
  const raw = process.env.AI_PROVIDER_PRIMARY;
  if (raw === "anthropic" || raw === "azure-openai" || raw === "auto") {
    return raw;
  }
  return "auto";
}

function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function pickPrimary(
  req: AICompleteRequest,
  registry: ProviderRegistry,
): AIProvider {
  const override = readPrimaryOverride();

  // Ask the SELECTION router first, unless an operator pinned a provider.
  //
  // Without this the two routers disagree: the executor records "we chose
  // azure-gpt-4o" while this function independently decides Azure or Anthropic,
  // and /admin/ai-router reports a model that may not have done the work.
  //
  // It only ever refines. bridgeSelection returns null whenever selection had
  // no real choice, named an unsupported tier, or picked a client-supplied
  // model — and the original logic below then runs untouched. There is no path
  // where this makes a call fail that would otherwise have succeeded.
  if (override === "auto") {
    const bridged = bridgeSelection(req.model_tier, registry);
    if (bridged) return bridged.provider;
  }

  if (override === "azure-openai" && registry.azure.supportsTier(req.model_tier)) {
    return registry.azure;
  }
  if (override === "anthropic") {
    return registry.anthropic;
  }
  if (
    isAzureConfigured() &&
    registry.azure.supportsTier(req.model_tier)
  ) {
    return registry.azure;
  }
  return registry.anthropic;
}

function pickFallback(
  primary: AIProvider,
  registry: ProviderRegistry,
  req: AICompleteRequest,
): AIProvider | null {
  if (primary === registry.anthropic) {
    if (
      isAzureConfigured() &&
      registry.azure.supportsTier(req.model_tier)
    ) {
      return registry.azure;
    }
    return null;
  }
  // Azure is primary; Anthropic is the fallback only if its key is set.
  if (isAnthropicConfigured()) return registry.anthropic;
  return null;
}

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  const name = (err as { name?: unknown }).name;
  if (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    name === "InternalServerError"
  ) {
    return true;
  }
  return false;
}

/**
 * Budget-enforcement dependencies, injected so the unit tests can drive the
 * gate without a live Postgres. In production these default to the real
 * loader + cost view (see buildRegistry / getAIClient call site below).
 */
interface BudgetDeps {
  loadPolicy: (workspaceId: string) => Promise<WorkspaceAIPolicy | null>;
  monthSpend: (workspaceId: string) => Promise<number>;
}

/**
 * Real-DB budget deps. Lazily imports db so the pure router tests that never
 * set DATABASE_URL don't pull in pg; loadWorkspacePolicy + monthSpendUsd both
 * fail OPEN (return null / 0) when the DB is unreachable, so a flaky cost view
 * never wedges live AI traffic.
 */
function defaultBudgetDeps(): BudgetDeps {
  return {
    loadPolicy: async (workspaceId) => {
      if (!process.env.DATABASE_URL) return null;
      const { query } = await import("@/lib/db");
      return loadWorkspacePolicy(workspaceId, async (sql, params) => {
        const r = await query(sql, params);
        return { rows: r.rows as unknown as WorkspaceAIPolicy[] };
      });
    },
    monthSpend: (workspaceId) => monthSpendUsd(workspaceId),
  };
}

/**
 * Enforcement-point design (see CTO directive - never escalate, fail cheap):
 *
 *   1. Per-call HARD block at the chokepoint (chosen). Before any provider
 *      dispatch, if the workspace is confirmed over its monthly_budget_usd we
 *      refuse the call entirely. This is the only option that makes runaway
 *      spend impossible: spend cannot exceed budget + one in-flight call.
 *   2. Soft-degrade to a cheaper tier. Rejected here: it only slows the
 *      bleed, it does not stop it. Tier clamping is already resolvePolicy's
 *      job (a separate, additive cost lever) and stays untouched.
 *   3. Async alert-only. Rejected: alerts notify a human after the money is
 *      already spent; useless as a hard cost ceiling for a client account.
 *
 * The hard block lives at the single AI chokepoint (router.complete) so every
 * feature inherits it for free, and it fails OPEN on any read error so the
 * analytics store hiccupping can never take down all AI traffic. resolvePolicy
 * continues to own tier clamping; this gate only owns the absolute ceiling.
 */
async function checkBudget(
  req: AICompleteRequest,
  deps: BudgetDeps,
): Promise<void> {
  const workspaceId = req.metadata?.workspace_id;
  // No workspace attribution -> behave exactly as before (no enforcement).
  if (!workspaceId || workspaceId.trim() === "") return;

  const policy = await deps.loadPolicy(workspaceId);
  // No policy or no budget set -> no enforcement, no regression.
  if (!policy || policy.monthly_budget_usd === null) return;

  const spend = await deps.monthSpend(workspaceId);
  if (!isOverBudget(policy, spend)) return;

  const feature = req.metadata?.feature ?? "unknown";
  // Tie into the registered analytics event so the learning loop + cost
  // dashboard see every block (fire-and-forget, never blocks the refusal).
  trackEvent(
    "ai.request_blocked_over_budget",
    req.metadata?.user_id ?? "system",
    req.metadata?.user_role ?? "system",
    {
      workspace_id: workspaceId,
      month_spend_usd: spend,
      budget_usd: policy.monthly_budget_usd,
      feature,
    },
  );

  throw new BudgetExceededError(
    `Workspace ${workspaceId} is over its monthly AI budget ($${spend.toFixed(2)} of $${policy.monthly_budget_usd}).`,
    {
      workspace_id: workspaceId,
      month_spend_usd: spend,
      budget_usd: policy.monthly_budget_usd,
      feature,
    },
  );
}

class RouterClient implements AIClient {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly budgetDeps: BudgetDeps = defaultBudgetDeps(),
  ) {}

  async complete(req: AICompleteRequest): Promise<AICompleteResponse> {
    // Hard budget gate BEFORE any provider dispatch. Throws
    // BudgetExceededError (a graceful, typed refusal - no model is charged)
    // when the workspace is confirmed over budget.
    await checkBudget(req, this.budgetDeps);

    // Governance chokepoint: when the caller opted in, prepend the OGIAM Agent
    // Constitution to the system prompt here, so every constitution-governed
    // surface (assistant + OGIAM agents) inherits the same rules regardless of
    // which model version answers. No-op for the other call sites.
    const cReq = applyConstitutionToRequest(req);

    // Resolved once and reused, so the provider we call and the model id we
    // report come from the SAME decision rather than two independent ones.
    const bridged = readPrimaryOverride() === "auto" ? bridgeSelection(cReq.model_tier, this.registry) : null;
    const primary = pickPrimary(cReq, this.registry);
    const obs = getObsClient();
    let response: AICompleteResponse;
    let fallbackUsed = false;

    /* Wrap each provider call in its own span so we capture latency
       per provider — including the failed primary when failover
       happens. Span name encodes the provider so traces are easy to
       filter in App Insights. */
    const baseAttrs = {
      feature: req.metadata?.feature ?? "unknown",
      tier: req.model_tier,
      sensitivity: req.sensitivity ?? null,
    };

    const primarySpan = obs.startSpan(`ai.completion.${primary.name}`, {
      ...baseAttrs,
      role: "primary",
    });
    try {
      response = await primary.complete(cReq);
      primarySpan.setAttribute("model_used", response.model_used);
      primarySpan.setAttribute("input_tokens", response.input_tokens);
      primarySpan.setAttribute("output_tokens", response.output_tokens);
      primarySpan.setAttribute("cost_usd", response.cost_usd);
      primarySpan.setAttribute("latency_ms", response.latency_ms);
      primarySpan.setAttribute("fallback_used", false);
      primarySpan.end("ok");
    } catch (err) {
      primarySpan.setAttribute("error_message", (err as Error).message);
      primarySpan.end("error");
      const fallback = pickFallback(primary, this.registry, cReq);
      if (fallback && isRetryableError(err)) {
        console.warn(
          `[ai/router] primary ${primary.name} failed (${(err as Error).message}); falling back to ${fallback.name}`,
        );
        const fbSpan = obs.startSpan(`ai.completion.${fallback.name}`, {
          ...baseAttrs,
          role: "fallback",
          primary_failed: primary.name,
        });
        try {
          response = await fallback.complete(cReq);
          fbSpan.setAttribute("model_used", response.model_used);
          fbSpan.setAttribute("input_tokens", response.input_tokens);
          fbSpan.setAttribute("output_tokens", response.output_tokens);
          fbSpan.setAttribute("cost_usd", response.cost_usd);
          fbSpan.setAttribute("latency_ms", response.latency_ms);
          fbSpan.setAttribute("fallback_used", true);
          fbSpan.end("ok");
        } catch (fbErr) {
          fbSpan.setAttribute("error_message", (fbErr as Error).message);
          fbSpan.end("error");
          obs.recordError(fbErr as Error, {
            ...baseAttrs,
            provider: fallback.name,
            role: "fallback",
          });
          throw fbErr;
        }
        fallbackUsed = true;
      } else {
        console.warn(
          `[ai/router] ${primary.name} failed with no usable fallback: ${(err as Error).message}`,
        );
        obs.recordError(err as Error, {
          ...baseAttrs,
          provider: primary.name,
          role: "primary",
        });
        throw err;
      }
    }

    /* Record the routing decision.
     *
     * /admin/ai-router is built entirely from ai.model_selected, and until now
     * only the agent task executor emitted it. Every other AI call in the
     * platform — the assistant most of all — made a selection through the
     * bridge above and then threw it away, so that page reported on a small
     * slice of traffic while presenting itself as the router's view.
     *
     * Emitted after the call succeeds, matching the executor: a decision that
     * never spent tokens is not a decision worth costing. */
    /* Record a selection for EVERY completion, not only the ones the bridge
       could act on.
       
       bridgeSelection returns null whenever selection had no real choice or
       named a provider this deployment cannot reach. Logging only the non-null
       case would have left exactly those calls invisible on /admin/ai-router —
       the ones where routing is doing least, which is precisely what an
       operator needs to see. `governed` records whether the decision actually
       drove the provider, so the page can distinguish "chose this" from
       "would have chosen this". */
    const recorded = bridged?.selection ?? safeSelect(cReq.model_tier);
    if (recorded) {
      logModelSelection(recorded, {
        userId: cReq.metadata?.user_id ?? "system",
        userRole: cReq.metadata?.user_role ?? "system",
        extra: {
          feature: cReq.metadata?.feature ?? "unknown",
          workspace_id: cReq.metadata?.workspace_id ?? "default",
          requested_tier: cReq.model_tier,
          /* Distinguishes these from the executor's own rows, which carry
             task_id, so the two paths stay countable apart. */
          source: "execution_router",
          /* False means selection expressed a preference the deployment could
             not honour, and the provider was picked by the environment. */
          governed: bridged !== null,
          ...(cReq.metadata?.routing_reason
            ? { routing_reason: cReq.metadata.routing_reason }
            : {}),
        },
      });
    }

    emitCompletionEvent(cReq, response, fallbackUsed, bridged?.spec.id);
    return response;
  }
}

/** selectModel, but never throws into a completion path. */
function safeSelect(tier: AICompleteRequest["model_tier"]) {
  try {
    return selectModel({ requiredTier: capabilityTierFor(tier) });
  } catch {
    return null;
  }
}

function emitCompletionEvent(
  req: AICompleteRequest,
  response: AICompleteResponse,
  fallbackUsed: boolean,
  selectedModelId?: string,
): void {
  const feature = req.metadata?.feature ?? "unknown";
  const userId = req.metadata?.user_id ?? "system";
  const userRole = req.metadata?.user_role ?? "system";
  const metadata: Record<string, string | number | boolean> = {
    feature,
    provider: response.provider_used,
    model: response.model_used,
    tier: req.model_tier,
    // What the SELECTION router would have picked, recorded alongside what
    // actually ran so the two are joinable and any divergence is visible in
    // data rather than only discoverable by reading both routers.
    ...(selectedModelId ? { selected_model_id: selectedModelId } : {}),
    input_tokens: response.input_tokens,
    output_tokens: response.output_tokens,
    cost_usd: response.cost_usd,
    latency_ms: response.latency_ms,
    fallback_used: fallbackUsed,
  };
  /* What this turn WOULD have cost at the tier this call site used to send
     unconditionally, priced on the tokens it actually used. Savings is then a
     subtraction over real rows rather than a claim: without this, a cheaper
     model looks like lower spend and nobody can prove it was not just lower
     usage. Best effort — a pricing lookup must never fail a completion. */
  if (req.metadata?.baseline_tier) {
    try {
      const baseline = selectModel({
        requiredTier: capabilityTierFor(req.metadata.baseline_tier),
      });
      const actual = selectModel({ requiredTier: capabilityTierFor(req.model_tier) });
      const price = (m: { inputPricePer1kUsd: number; outputPricePer1kUsd: number }) =>
        (response.input_tokens / 1000) * m.inputPricePer1kUsd +
        (response.output_tokens / 1000) * m.outputPricePer1kUsd;

      /* Both sides priced off the SAME list, on the SAME tokens.
         Subtracting the provider's billed cost_usd from a registry-priced
         baseline would compare two different price lists and manufacture a
         saving (or hide one) purely from which catalogue was consulted. */
      const baselineCost = price(baseline.model);
      const routedCost = price(actual.model);
      metadata.baseline_tier = req.metadata.baseline_tier;
      metadata.baseline_model_id = baseline.model.id;
      metadata.baseline_cost_usd = baselineCost;
      metadata.routed_cost_usd = routedCost;
      metadata.savings_usd = baselineCost - routedCost;
    } catch {
      /* no baseline recorded; the completion still stands */
    }
  }
  if (req.metadata?.routing_reason) metadata.routing_reason = req.metadata.routing_reason;
  if (req.sensitivity) metadata.sensitivity = req.sensitivity;
  metadata.constitution_applied = !!req.apply_constitution;
  trackEvent("ai.completion", userId, userRole, metadata);
}

let cachedClient: AIClient | null = null;

export function getAIClient(): AIClient {
  if (cachedClient) return cachedClient;
  cachedClient = new RouterClient(buildRegistry());
  return cachedClient;
}

export function _resetAIClientForTests(client: AIClient | null = null): void {
  cachedClient = client;
}

/**
 * Test-only: build a RouterClient with injected budget deps so the budget
 * gate can be driven without a live Postgres. Also caches it as the singleton
 * so getAIClient() returns the same instance for the rest of the test.
 */
export function _buildAIClientWithBudgetDepsForTests(deps: {
  loadPolicy: (workspaceId: string) => Promise<WorkspaceAIPolicy | null>;
  monthSpend: (workspaceId: string) => Promise<number>;
}): AIClient {
  cachedClient = new RouterClient(buildRegistry(), deps);
  return cachedClient;
}

export { BudgetExceededError, NoProviderAvailableError };
