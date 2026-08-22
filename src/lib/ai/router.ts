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
import { redactMessages, redactText, NEVER_SEND_KINDS } from "./redaction";
import {
  applyPolicy,
  policyFor,
  isWithheld,
  type PolicyVerdict,
} from "./policy";
import { getObsClient } from "@/lib/obs";

import { AnthropicProvider } from "./anthropic-provider";
import {
  AzureOpenAIProvider,
  isAzureConfigured,
} from "./azure-openai-provider";
import { buildCompatibleProviders } from "./openai-compatible-provider";
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
import { governTier, CEILING_MULTIPLE, type BudgetDecision } from "./budget";
import { recordRouterCall } from "./audit-record-writer";
import {
  mayServe,
  zeroRetentionProviders,
  RetentionPolicyError,
} from "./retention";
import {
  mayProcessHere,
  regionOfModel,
  ResidencyPolicyError,
} from "./residency";
import { verifyAnswer, shouldEscalate } from "./verification";
import { judgeAnswer, type JudgeResult, unjudged } from "./judge";
import { chooseIndependentJudge, type JudgeCandidate } from "./judge-selection";
import { MODEL_REGISTRY, isModelAvailable } from "@/lib/ai/models/registry";
import { recordServedVersion } from "@/lib/ai/models/version-store";
import { ANTHROPIC_TIER_TO_MODEL } from "./anthropic-provider";

interface ProviderRegistry {
  anthropic: AIProvider;
  azure: AIProvider;
  /* Providers that speak the OpenAI chat-completions shape, added by
     configuration rather than code. Empty on a deployment that has configured
     none, which is every deployment until somebody opts in. */
  compatible: AIProvider[];
}

function buildRegistry(): ProviderRegistry {
  return {
    anthropic: new AnthropicProvider(),
    azure: new AzureOpenAIProvider(),
    compatible: buildCompatibleProviders(),
  };
}

type PrimaryOverride = "anthropic" | "azure-openai" | "auto" | (string & {});

function readPrimaryOverride(): PrimaryOverride {
  const raw = process.env.AI_PROVIDER_PRIMARY;
  if (raw === "anthropic" || raw === "azure-openai" || raw === "auto") {
    return raw;
  }
  /* A configured compatible provider may be pinned by its own id. Anything
     unrecognised still falls through to "auto", so a typo degrades to the
     normal behaviour rather than to an outage. */
  if (raw && buildCompatibleProviders().some((p) => p.name === raw)) return raw;
  return "auto";
}

function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * The provider that WILL serve this request, by name.
 *
 * Resolved through pickPrimary so the retention gate judges the provider that
 * is actually about to be called rather than a guess at it. Never throws: a
 * registry that cannot name a provider returns "unknown", which no
 * zero-retention list contains, so the gate refuses. Failing closed on an
 * unanswerable question is the correct direction here.
 */
function primaryProviderName(
  registry: ProviderRegistry,
  req: AICompleteRequest,
): string {
  try {
    return pickPrimary(req, registry).name;
  } catch {
    return "unknown";
  }
}

function pickPrimary(
  req: AICompleteRequest,
  registry: ProviderRegistry,
): AIProvider {
  /* A per-request pin beats every other rule, because the only caller that
     sets one has already decided WHICH provider must answer and why. Ignored
     when that provider is missing or cannot serve the tier, so a stale pin
     degrades to normal routing instead of failing the call. */
  if (req.provider_pin) {
    const all = [registry.anthropic, registry.azure, ...registry.compatible];
    const pinned = all.find((p) => p.name === req.provider_pin);
    if (pinned && pinned.supportsTier(req.model_tier)) return pinned;
  }

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

  /* A compatible provider serves only when pinned by name. Deliberately not
     part of automatic selection: these are added by configuration, so an
     unnoticed environment variable could otherwise silently move production
     traffic onto a model nobody reviewed. Pinning is a decision somebody
     makes; a default is one that makes itself. */
  const pinned = registry.compatible.find((p) => p.name === override);
  if (pinned && pinned.supportsTier(req.model_tier)) return pinned;

  if (
    override === "azure-openai" &&
    registry.azure.supportsTier(req.model_tier)
  ) {
    return registry.azure;
  }
  if (override === "anthropic") {
    return registry.anthropic;
  }
  if (isAzureConfigured() && registry.azure.supportsTier(req.model_tier)) {
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
    if (isAzureConfigured() && registry.azure.supportsTier(req.model_tier)) {
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
  /* Loaded ONCE by the caller and passed down, because the content-policy gate
     needs the same row. Two reads of a single-row table per AI call would be
     two chances for them to disagree about the same workspace. */
  preloaded: WorkspaceAIPolicy | null,
): Promise<BudgetDecision> {
  const passthrough: BudgetDecision = {
    state: "ok",
    tier: req.model_tier,
    stop: false,
    reason: "no_cap",
    notice: null,
    fraction: null,
  };

  const workspaceId = req.metadata?.workspace_id;
  // No workspace attribution -> behave exactly as before (no enforcement).
  if (!workspaceId || workspaceId.trim() === "") return passthrough;

  const policy = preloaded;
  // No policy or no budget set -> no enforcement, no regression.
  if (!policy || policy.monthly_budget_usd === null) return passthrough;

  const spend = await deps.monthSpend(workspaceId);

  /* A GOVERNOR, NOT A WALL.
   *
   * This used to throw the moment spend passed the cap, which is what
   * OpenRouter's 402 does and what I argued against before noticing we did it
   * too. A hard cap does not arrive when the finance team is looking; it
   * arrives while somebody is mid-sentence to a client. So caps get set high
   * enough never to fire, or somebody raises them in a hurry. Either way the
   * control is theatre.
   *
   * Capability now degrades before service is refused: near the cap a premium
   * question is served by a standard model, over it by the cheapest one, and
   * only a workspace at twice its cap is stopped, because that is a
   * malfunction rather than a budget. See lib/ai/budget.ts. */
  const decision = governTier({
    spentUsd: spend,
    capUsd: policy.monthly_budget_usd,
    requestedTier: req.model_tier,
  });

  const feature = req.metadata?.feature ?? "unknown";

  if (decision.state === "approaching" || decision.state === "over") {
    /* Recorded so a degraded answer is never invisible: somebody comparing
       this week's answers with last week's deserves to find the reason in
       data rather than guess at it. */
    trackEvent(
      "ai.budget_degraded",
      req.metadata?.user_id ?? "system",
      req.metadata?.user_role ?? "system",
      {
        workspace_id: workspaceId,
        month_spend_usd: spend,
        budget_usd: policy.monthly_budget_usd,
        requested_tier: req.model_tier,
        served_tier: decision.tier,
        state: decision.state,
        feature,
      },
    );
    return decision;
  }

  if (!decision.stop) return decision;
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
    `Workspace ${workspaceId} has reached ${CEILING_MULTIPLE} times its monthly AI budget ($${spend.toFixed(2)} of $${policy.monthly_budget_usd}) and is paused.`,
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
    /* Budget governor BEFORE any provider dispatch. It clamps the tier as a
       workspace approaches its cap, and throws BudgetExceededError (a typed
       refusal, no model charged) only at the ceiling. */
    /* ONE READ OF THE WORKSPACE'S POLICY ROW, serving both gates below: what
       this call may COST (the budget governor) and what its answer may SAY
       (the content policy). Fails open to null exactly as before. */
    const wsId = req.metadata?.workspace_id?.trim() ?? "";
    /* FAILS OPEN, LOUDLY IN NEITHER DIRECTION. loadWorkspacePolicy swallows its
       own errors today, but the deps wrapper around it does a dynamic import
       and a query, and either can throw. Without this catch an unreachable
       database would stop being a lost cost-cap and start being a failed AI
       call for every workspace at once. */
    let wsPolicy: WorkspaceAIPolicy | null = null;
    if (wsId) {
      try {
        wsPolicy = await this.budgetDeps.loadPolicy(wsId);
      } catch {
        wsPolicy = null;
      }
    }

    const budget = await checkBudget(req, this.budgetDeps, wsPolicy);

    /* The clamped tier is applied HERE, once, so everything downstream, the
       selection router, the bridge, the completion event and the cost figures,
       all describe the call that was actually made. Threading a "requested"
       tier alongside a "served" one would give two answers to one question. */
    const governed: AICompleteRequest =
      budget.tier === req.model_tier
        ? req
        : { ...req, model_tier: budget.tier };

    // Governance chokepoint: when the caller opted in, prepend the OGIAM Agent
    // Constitution to the system prompt here, so every constitution-governed
    // surface (assistant + OGIAM agents) inherits the same rules regardless of
    // which model version answers. No-op for the other call sites.
    const cReq0 = applyConstitutionToRequest(governed);

    /* SENSITIVE DATA MAY ONLY GO WHERE WE HAVE AN AGREEMENT.
     *
     * The request already declares its sensitivity; until now that only
     * decided how hard to redact. It now also decides WHO may answer: a
     * request carrying personal or health data may only be served by a
     * provider under a zero-retention agreement (AI_ZERO_RETENTION_PROVIDERS).
     *
     * Checked here, after the provider is resolved and before a single byte
     * leaves, and it FAILS CLOSED. Everywhere else in this router degrading
     * gracefully is the right instinct; here it would mean sending a medical
     * record to a provider that keeps prompts because somebody had not
     * finished the configuration. */
    const trustedProviders = zeroRetentionProviders();
    const retention = mayServe({
      sensitivity: cReq0.sensitivity,
      provider: primaryProviderName(this.registry, cReq0),
      trusted: trustedProviders,
    });

    /* ENFORCEMENT IS OPT-IN, AND THAT IS NOT A WEAKENING.
     *
     * The rule in retention.ts says an unconfigured estate trusts nobody, which
     * is correct. Enforcing that the moment this deploys would refuse every
     * live request carrying personal or health data, on an estate where nobody
     * has yet been asked which providers are under an agreement. That is not a
     * control, it is an outage with a principled explanation.
     *
     * So the gate turns on when somebody names the trusted providers. Until
     * then every restricted request is recorded as UNPROTECTED, once per call,
     * because the honest state of the world is "we do not yet enforce this"
     * and it should be visible rather than assumed. */
    if (retention.reason === "none_configured") {
      trackEvent(
        "ai.retention_unenforced",
        cReq0.metadata?.user_id ?? "system",
        cReq0.metadata?.user_role ?? "system",
        {
          feature: cReq0.metadata?.feature ?? "unknown",
          workspace_id: cReq0.metadata?.workspace_id ?? "default",
          sensitivity: String(cReq0.sensitivity),
          provider: primaryProviderName(this.registry, cReq0),
        },
      );
    } else if (!retention.allowed) {
      trackEvent(
        "ai.request_blocked_retention",
        cReq0.metadata?.user_id ?? "system",
        cReq0.metadata?.user_role ?? "system",
        {
          feature: cReq0.metadata?.feature ?? "unknown",
          workspace_id: cReq0.metadata?.workspace_id ?? "default",
          sensitivity: String(cReq0.sensitivity),
          reason: retention.reason,
        },
      );
      /* Reaching here means providers ARE named and this one is not among
         them, which is the only refusal case: the unconfigured estate took the
         branch above. */
      throw new RetentionPolicyError(
        "This request carries sensitive data and the available provider is not under a zero-retention agreement.",
        {
          sensitivity: String(cReq0.sensitivity),
          provider: primaryProviderName(this.registry, cReq0),
          reason: retention.reason,
        },
      );
    }

    /* Credential / financial-identifier gate, at the last point before the
     * prompt leaves this process.
     *
     * redaction.ts was written for exactly this ("before they leave the process
     * boundary to an LLM provider") and only the OGIAM agent path ever called
     * it. The assistant — where a person can paste anything into a chat box —
     * had no gate at all.
     *
     * Applied HERE rather than in the assistant so every surface inherits it:
     * chat, agents, drafting, anything that completes. A guardrail one call
     * site remembers to use is the guardrail that was missing.
     *
     * Scoped to NEVER_SEND_KINDS. Email and phone are the product's subject
     * matter and are deliberately untouched — see the note on that constant. */
    const gated = redactMessages(
      cReq0.messages,
      cReq0.system,
      cReq0.sensitivity,
      NEVER_SEND_KINDS,
    );
    const cReq =
      gated.count > 0
        ? {
            ...cReq0,
            messages: gated.messages as typeof cReq0.messages,
            system: gated.system,
          }
        : cReq0;

    if (gated.count > 0) {
      /* What was found, never the value itself — hits carry placeholders only.
         Which kinds people paste, and from which surface, is exactly the signal
         that says where to put a warning in the UI. */
      trackEvent(
        "ai.prompt_redacted",
        cReq.metadata?.user_id ?? "system",
        cReq.metadata?.user_role ?? "system",
        {
          feature: cReq.metadata?.feature ?? "unknown",
          workspace_id: cReq.metadata?.workspace_id ?? "default",
          redacted_count: gated.count,
          kinds: [...new Set(gated.hits.map((h) => h.kind))].sort().join(","),
        },
      );
    }

    // Resolved once and reused, so the provider we call and the model id we
    // report come from the SAME decision rather than two independent ones.
    const bridged =
      readPrimaryOverride() === "auto"
        ? bridgeSelection(cReq.model_tier, this.registry)
        : null;
    const primary = pickPrimary(cReq, this.registry);

    /* WHERE THIS DATA MAY BE PROCESSED.
     *
     * Judged here rather than beside the retention gate because this is the
     * first point where the MODEL is known, and region is a property of a
     * deployment, not of a provider: one Azure resource in Sweden and one in
     * Iowa is an ordinary estate, and a provider-wide answer would be
     * confidently wrong about half of it. Nothing has been dispatched yet.
     *
     * Unlike retention, this gate needs no opt-in and has no unenforced state.
     * It only acts on requests that DECLARE a requirement, so an estate that
     * has never thought about residency is unaffected, and one that has is
     * protected the moment a caller says so. Silence is not consent here: a
     * declared requirement against an undeclared region is refused, because
     * "we did not know where it ran" is the answer that ends badly. */
    let residencyRecord: { required: string[]; servedIn: string } | undefined;
    if (cReq.residency && cReq.residency.length > 0) {
      const modelId = bridged?.spec.id ?? primary.name;
      const servedIn = regionOfModel({ modelId, provider: primary.name });
      const residency = mayProcessHere({ required: cReq.residency, servedIn });
      if (!residency.allowed) {
        trackEvent(
          "ai.request_blocked_residency",
          cReq.metadata?.user_id ?? "system",
          cReq.metadata?.user_role ?? "system",
          {
            feature: cReq.metadata?.feature ?? "unknown",
            workspace_id: cReq.metadata?.workspace_id ?? "default",
            required: residency.required.join(","),
            served_in: residency.servedIn,
            provider: primary.name,
            model: modelId,
            reason: residency.reason,
          },
        );
        throw new ResidencyPolicyError(
          residency.reason === "region_undeclared"
            ? "This request may only be processed in specific regions, and the region of the available model has not been declared."
            : "This request may only be processed in specific regions, and no available model runs in one of them.",
          {
            required: residency.required,
            servedIn: residency.servedIn,
            provider: primary.name,
            reason: residency.reason,
          },
        );
      }
      /* Recorded from the SAME verdict that allowed the call, never
         recomputed later: a second read of the environment could disagree
         with the one that made the decision, and the row would then attest
         to something that never happened. */
      residencyRecord = {
        required: residency.required,
        servedIn: residency.servedIn,
      };
    }
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

    /* THE RETURN PATH, at the same chokepoint as the outbound one.
     *
     * The gate above stops a credential LEAVING. Nothing checked what came
     * BACK, and a model can put one in an answer without inventing it: the
     * conversation, a pasted log, an attached file, or a retrieved document
     * can all carry a key that the model then quotes in its reply. That reply
     * is rendered, stored on the message row, and read by everyone in the
     * workspace, so a secret that was handled carefully on the way out
     * reappears in permanent, shared text on the way in.
     *
     * Same function, same kinds, both directions. Reusing redactText rather
     * than writing a second matcher means the two directions cannot disagree
     * about what a credential looks like, which is the failure mode of every
     * scanner that gets implemented twice.
     *
     * DEGRADES, NEVER FAILS: a redaction problem must not turn a completed
     * answer into an error, so anything unexpected leaves the response as it
     * was rather than losing it. */
    const inboundWithheld: { count: number; kinds: string[] } = {
      count: 0,
      kinds: [],
    };
    try {
      const outbound = redactText(response.content, NEVER_SEND_KINDS);
      if (outbound.redacted && outbound.hits.length > 0) {
        response = { ...response, content: outbound.text };
        inboundWithheld.count = outbound.hits.length;
        inboundWithheld.kinds = [...new Set(outbound.hits.map((h) => h.kind))];
        trackEvent(
          "ai.response_redacted",
          cReq.metadata?.user_id ?? "system",
          cReq.metadata?.user_role ?? "system",
          {
            feature: cReq.metadata?.feature ?? "unknown",
            workspace_id: cReq.metadata?.workspace_id ?? "default",
            model: response.model_used,
            redacted_count: outbound.hits.length,
            /* The kind only. Placeholders travel, values never do, which is
               what lets this be reported on a page at all. */
            kinds: [...new Set(outbound.hits.map((h) => h.kind))]
              .sort()
              .join(","),
          },
        );
      }
    } catch {
      /* An answer the reader has waited for is worth more than a redaction
         pass that threw. The outbound gate already ran. */
    }

    /* THE SECOND GATE: what the answer SAYS, not what it contains.
     *
     * Redaction above is exhaustive about shapes and blind to meaning. It will
     * not touch "you'll qualify for 2.9% APR", "that's covered under your
     * warranty" or "yes, it's in stock, I'll hold one for you", because none of
     * those contains a redactable token -- and every one of them is a
     * commitment the CLIENT is held to, made by a model that cannot be.
     *
     * So the router is the layer between the model and the reader here too:
     * deterministic rules, per tenant, reviewable in a diff. See policy.ts for
     * why this is rules and not a classifier.
     *
     * WITHHOLDING REPLACES THE ANSWER, IT DOES NOT THROW. A caller that gets an
     * exception has to handle a failure; a caller that gets a short, true
     * sentence just renders it. The refusal is still a completed call: it was
     * paid for, it is recorded, and the reader is told plainly that something
     * was held back rather than being handed silence.
     *
     * DEGRADES, NEVER FAILS, same posture as the block above: a policy pass
     * that throws leaves the answer exactly as it was. A gate that can take an
     * answer down is a gate an operator switches off. */
    let policyVerdict: PolicyVerdict | null = null;
    /* The judge's verdict ABOUT an answer is not an answer. Skipping it here,
       rather than inside the try, keeps "we chose not to gate this" separate
       from "the gate failed and we degraded". */
    if (!cReq.metadata?.internal_check) {
      try {
        const rules = policyFor(
          wsPolicy?.content_policy_profile ??
            process.env.AI_CONTENT_POLICY_PROFILE,
        );
        const verdict = applyPolicy(response.content, "response", rules);
        if (verdict.action !== "allow") {
          policyVerdict = verdict;
          response = { ...response, content: verdict.text };
          trackEvent(
            "ai.policy_refused",
            cReq.metadata?.user_id ?? "system",
            cReq.metadata?.user_role ?? "system",
            {
              feature: cReq.metadata?.feature ?? "unknown",
              workspace_id: cReq.metadata?.workspace_id ?? "default",
              model: response.model_used,
              action: verdict.action,
              profile:
                wsPolicy?.content_policy_profile ??
                process.env.AI_CONTENT_POLICY_PROFILE ??
                "baseline",
              /* Rule ids only. The panel explains a refusal from the RULE, never
               by replaying what the model said: a store of blocked sentences
               is a store of exactly the text we decided nobody should read. */
              rules: verdict.findings
                .map((f) => f.ruleId)
                .sort()
                .join(","),
              rule_count: verdict.findings.length,
            },
          );
        }
      } catch {
        /* See above. An unusable policy pass costs coverage, never answers. */
      }
    }

    emitCompletionEvent(cReq, response, fallbackUsed, bridged?.spec.id);

    /* THE COMPLIANCE RECORD, distinct from the analytics event above.
     *
     * Analytics is observability: counts that answer "how is this behaving".
     * This is evidence: append-only, hash-chained and reproducible, so a
     * regulated client asking what left their tenancy gets an answer they can
     * verify rather than a dashboard they have to trust.
     *
     * Written last, after the call is complete, so a row exists only for a
     * call that actually happened. Never blocks and never throws: an audit
     * failure must not turn a finished answer into an error, and recordAudit
     * already fails closed by reporting rather than by rejecting. */
    /* WHICH WEIGHTS ANSWERED. Fire and forget, after the response is settled:
       every gate here keys on a model id, and an id is a name whose meaning the
       provider can change without telling anybody. Recording what actually
       served is what makes a later regression explainable rather than a
       mystery about when things got worse. */
    void recordServedVersion({
      modelId: bridged?.spec.id ?? response.model_used,
      servedVersion: response.model_used,
      provider: response.provider_used,
      workspaceId: cReq.metadata?.workspace_id,
      feature: cReq.metadata?.feature,
    }).catch(() => undefined);

    void recordRouterCall({
      workspaceId: cReq.metadata?.workspace_id ?? "default",
      userId: cReq.metadata?.user_id ?? "system",
      feature: cReq.metadata?.feature ?? "unknown",
      model: bridged?.spec.id ?? response.model_used,
      provider: response.provider_used,
      requestedTier: req.model_tier,
      servedTier: cReq.model_tier,
      inputTokens: response.input_tokens,
      outputTokens: response.output_tokens,
      costUsd: response.cost_usd,
      withheldOutbound: gated.count,
      withheldInbound: inboundWithheld.count,
      withheldKinds: [
        ...new Set([
          ...gated.hits.map((h) => h.kind),
          ...inboundWithheld.kinds,
        ]),
      ],
      injectionAttempts: 0,
      ...(budget.state === "ok" ? {} : { budgetState: budget.state }),
      ...(residencyRecord ? { residency: residencyRecord } : {}),
      ...(policyVerdict && policyVerdict.action !== "allow"
        ? {
            policy: {
              action: policyVerdict.action,
              rules: policyVerdict.findings.map((f) => f.ruleId),
              profile:
                wsPolicy?.content_policy_profile ??
                process.env.AI_CONTENT_POLICY_PROFILE ??
                "baseline",
            },
          }
        : {}),
    });

    /* ONE RETRY, ON A BETTER MODEL, ONLY WHEN A RULE SAYS IT IS WORTH PAYING.
     *
     * Opt-in per request. The checking itself is free (pure rules over the text
     * that came back) and runs only when a caller asked for it, so no existing
     * call site changes shape or cost.
     *
     * The whole cost argument rests on this staying CONDITIONAL. An ordinary
     * request pays for one cheap call and no retry. A request the cheap model
     * fluffed pays for two, which is what an unverified router would have spent
     * anyway while returning the worse answer.
     *
     * Deliberately ONE retry, not a loop. A model that failed twice is not
     * going to be talked round by a third attempt, and a loop here is an
     * unbounded bill attached to a single user action.
     *
     * A refusal is NOT escalated. A model declining is very often the system
     * working, and paying a larger model to overrule it is the opposite of a
     * safety feature. See verification.ts.
     *
     * DEGRADES, NEVER FAILS: if the retry throws, the original answer is
     * returned. A verified answer is better than the first one; the first one
     * is much better than an error. */
    if (req.verify) {
      const question = lastUserText(cReq);
      const verdict = verifyAnswer({ answer: response.content, question });
      const escalateTo = betterTier(cReq.model_tier);

      /* THE CHECK RULES CANNOT MAKE, and only when the caller paid for it.
       *
       * Asked only if the free rules found nothing: an answer already known to
       * be truncated does not need a model's opinion on whether it is sound,
       * and asking anyway is a second call bought for no new information.
       *
       * The judge is one tier ABOVE the model being judged where possible. A
       * small model marking its own homework is the weakest configuration of
       * this idea, and it is the one you get by default if nobody chooses.
       *
       * It runs through this same router, so it inherits redaction, residency
       * and the budget: the judge cannot see a credential the answer could not,
       * and it cannot spend past a ceiling the workspace has already hit. */
      let judged: JudgeResult | null = null;
      let judgeChoice: ReturnType<typeof chooseIndependentJudge> | null = null;
      if (req.verify === "deep" && verdict.sufficient && question) {
        /* THE CHECK MUST COME FROM A DIFFERENT FAMILY.
         *
         * Escalating a tier within whatever provider already answered means, on
         * an estate served by one vendor, a Claude answer judged by Claude.
         * That is not independence, it is the same training distribution
         * marking its own homework, and it fails by agreeing.
         *
         * Candidates are offered in the order the router would prefer them, so
         * the cheapest independent lineage wins. If none exists, the answer is
         * recorded as UNCHECKED rather than checked by a sibling: a reassuring
         * audit row that means nothing is worse than an honest gap, because a
         * gap gets fixed and a false reassurance gets cited. */
        judgeChoice = chooseIndependentJudge(
          {
            provider: response.provider_used,
            model: bridged?.spec.id ?? response.model_used,
          },
          judgeCandidates(this.registry, escalateTo ?? cReq.model_tier),
        );

        judged = judgeChoice.candidate
          ? await judgeAnswer(
              { question, answer: response.content },
              async ({ system, prompt, maxTokens }) => {
                const r = await this.complete({
                  messages: [{ role: "user", content: prompt }],
                  system,
                  max_tokens: maxTokens,
                  model_tier: escalateTo ?? cReq.model_tier,
                  /* verify:false on the judge's own call. A judge judged by a
                     judge is a bill with no upper bound. */
                  verify: false,
                  sensitivity: cReq.sensitivity,
                  ...(cReq.residency ? { residency: cReq.residency } : {}),
                  metadata: {
                    ...cReq.metadata,
                    feature: `${cReq.metadata?.feature ?? "unknown"}.judge`,
                    /* The judge reports ON claims; it does not make them. See
                       AICompleteRequestMetadata.internal_check. */
                    internal_check: true,
                  },
                  provider_pin: judgeChoice!.candidate!.provider,
                });
                return r.content;
              },
            )
          : unjudged(
              judgeChoice.reason === "author_lineage_unknown"
                ? "No independent check: the family of the answering model is not recognised."
                : "No independent check: every configured model shares a family with the one that answered.",
            );
        trackEvent(
          "ai.answer_judged",
          cReq.metadata?.user_id ?? "system",
          cReq.metadata?.user_role ?? "system",
          {
            feature: cReq.metadata?.feature ?? "unknown",
            workspace_id: cReq.metadata?.workspace_id ?? "default",
            model: response.model_used,
            sound: judged.sound,
            verdict: judged.verdict,
            /* The claim an auditor can test. "Checked" says nothing; "checked
               by a different family, and here are both" can be argued with. */
            author_lineage: judgeChoice?.authorLineage ?? "unknown",
            judge_lineage: judgeChoice?.judgeLineage ?? "none",
            independence: judgeChoice?.reason ?? "not_attempted",
            /* "Checked and fine" and "could not be checked" both ship the
               answer, and only one of them is evidence. */
            judged: judged.judged,
          },
        );
      }

      trackEvent(
        "ai.answer_verified",
        cReq.metadata?.user_id ?? "system",
        cReq.metadata?.user_role ?? "system",
        {
          feature: cReq.metadata?.feature ?? "unknown",
          workspace_id: cReq.metadata?.workspace_id ?? "default",
          model: response.model_used,
          sufficient: verdict.sufficient,
          flags: verdict.flags.join(","),
          /* Recorded even when nothing was escalated, because "the cheap model
             was fine" is the finding that justifies routing cheap at all, and
             it is invisible if only failures are counted. */
          escalated:
            Boolean(escalateTo) &&
            (shouldEscalate(verdict) || judged?.sound === false),
        },
      );
      if (escalateTo && (shouldEscalate(verdict) || judged?.sound === false)) {
        try {
          const retried = await this.complete({
            ...req,
            model_tier: escalateTo,
            /* verify:false on the retry. The escalation already happened; a
               second check could only trigger a third call this design has
               deliberately ruled out. */
            verify: false,
            metadata: {
              ...req.metadata,
              feature: `${req.metadata?.feature ?? "unknown"}.escalated`,
            },
          });
          return retried;
        } catch {
          /* Keep the answer we have. */
        }
      }
    }

    return response;
  }
}

/** The next tier up, or null at the top. Escalation is one step, never a leap
 *  to the most expensive model available: the failure being fixed is usually a
 *  small model being small, not a hard problem needing the best model made. */
function betterTier(
  tier: AICompleteRequest["model_tier"],
): AICompleteRequest["model_tier"] | null {
  if (tier === "cheap") return "standard";
  if (tier === "standard") return "premium";
  return null;
}

/** The last thing the user actually said, for the verifier's context. */
function lastUserText(req: AICompleteRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return undefined;
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
      const actual = selectModel({
        requiredTier: capabilityTierFor(req.model_tier),
      });
      const price = (m: {
        inputPricePer1kUsd: number;
        outputPricePer1kUsd: number;
      }) =>
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
  if (req.metadata?.routing_reason)
    metadata.routing_reason = req.metadata.routing_reason;
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

/**
 * Providers that could check an answer, cheapest first.
 *
 * BUILT FROM PROVIDERS THAT ACTUALLY EXIST HERE, paired with the model each
 * would really use. An earlier version read candidates straight out of the
 * model registry, which lists families this deployment has no provider for
 * (OpenAI direct) and names providers differently from the registry ("azure"
 * against "azure-openai"). Both produce a candidate that passes the
 * independence check and then cannot be pinned, so the judge would quietly run
 * on whatever routing preferred: exactly the sibling review this is meant to
 * prevent, with a row claiming otherwise.
 *
 * The model matters as much as the provider, because lineage is a fact about
 * the model: azure-gpt-4o and gpt-4o are the same weights through different
 * doors.
 */
function judgeCandidates(
  registry: ProviderRegistry,
  tier: AICompleteRequest["model_tier"],
): JudgeCandidate[] {
  const out: JudgeCandidate[] = [];

  if (registry.anthropic.supportsTier(tier)) {
    out.push({
      provider: registry.anthropic.name,
      model: ANTHROPIC_TIER_TO_MODEL[tier],
    });
  }

  if (registry.azure.supportsTier(tier)) {
    /* The Azure entry for this capability tier, so the judge's lineage is read
       from the model rather than guessed from the reseller. */
    const wanted = capabilityTierFor(tier);
    const spec = MODEL_REGISTRY.find(
      (m) =>
        m.provider === "azure" &&
        m.capabilityTier === wanted &&
        isModelAvailable(m),
    );
    out.push({ provider: registry.azure.name, model: spec?.id });
  }

  for (const p of registry.compatible) {
    if (!p.supportsTier(tier)) continue;
    out.push({
      provider: p.name,
      model: (
        p as {
          modelFor?: (t: AICompleteRequest["model_tier"]) => string | undefined;
        }
      ).modelFor?.(tier),
    });
  }

  return out;
}
