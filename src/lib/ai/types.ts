/**
 * src/lib/ai/types, provider-neutral shapes for the AI abstraction.
 *
 * Every feature that needs a model call goes through getAIClient() (see
 * router.ts) and speaks AICompleteRequest / AICompleteResponse only.
 * That keeps the per-call site free of provider details so swapping
 * Anthropic, Azure OpenAI, or any future provider is a routing change,
 * not a feature rewrite.
 */

export type AIModelTier = "cheap" | "standard" | "premium";

export type AISensitivity = "public" | "pii" | "phi";

export type AILatencyTarget = "real_time" | "standard" | "batch";

export type AIRole = "system" | "user" | "assistant";

export interface AIMessage {
  role: AIRole;
  content: string;
}

export interface AICompleteRequestMetadata {
  feature: string;
  user_id?: string;
  user_role?: string;
  /** Owning workspace, drives per-team cost attribution + chargeback
   *  (v_ai_cost_daily) and per-workspace routing policy. Falls back to
   *  "default" in the gateway when a call site omits it. */
  workspace_id?: string;
  /** Why the caller asked for this tier, e.g. "trivial_turn". Recorded on the
   *  selection so an operator can tell a deliberate downgrade from a bug. */
  routing_reason?: string;
  /** The tier this call site used to send unconditionally. Present only where
   *  per-turn routing replaced a hardcoded tier, and used to price what the
   *  old behaviour WOULD have cost for the same tokens — so "savings" is
   *  measured against a real counterfactual rather than asserted. */
  baseline_tier?: AIModelTier;
  /**
   * This call is the router talking to itself, not to a person.
   *
   * The content policy (src/lib/ai/policy.ts) reads a model's answer and
   * withholds claims a business cannot be held to. That is right for an answer
   * somebody will READ, and wrong for the judge's verdict about one: a judge
   * reporting "the answer guarantees a price" is doing its job, and gating it
   * would withhold the finding instead of the claim.
   *
   * Set ONLY by the router on its own sub-calls. Never a way for a feature to
   * opt out of the gate: redaction, residency and the budget all still apply.
   */
  internal_check?: boolean;
}

export interface AICompleteRequest {
  messages: AIMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  model_tier: AIModelTier;
  sensitivity?: AISensitivity;
  latency_target?: AILatencyTarget;
  metadata?: AICompleteRequestMetadata;
  /**
   * Opt in to prepend the OGIAM Agent Constitution to `system` at the router
   * chokepoint (see src/lib/constitution). Off by default so cheap, high-volume
   * completions are never bloated; the assistant + OGIAM agent surfaces set it.
   */
  apply_constitution?: boolean;
  /**
   * Regions this request's data may be processed in, lowercase (e.g. ["eu"]).
   *
   * Omitted means no requirement, which is the honest default: most questions
   * genuinely have none, and inventing one for them would turn a control into
   * an outage. When present the router refuses any model it cannot place
   * inside one of these regions, INCLUDING a model whose region nobody has
   * declared. See src/lib/ai/residency.ts.
   */
  residency?: string[];
  /**
   * Check the answer before returning it, and retry once on a better model if
   * a rule says it fell short.
   *
   * OFF BY DEFAULT, and that is a cost decision rather than caution. Checking
   * is free (the rules are pure functions) but the retry is not, so a caller
   * turns this on where a thin answer costs more than a second call: drafting,
   * client-facing text, anything a person will act on without reading twice.
   *
   * The saving argument depends on this being CONDITIONAL. An ordinary request
   * pays for one cheap call and zero retries. Only the request the cheap model
   * fluffed pays twice, which is what a router with no verification would have
   * spent anyway while returning the worse answer.
   *
   * `true` runs the free rules only. `"deep"` additionally asks a model whether
   * the answer is SOUND, which rules cannot judge: a confident wrong answer
   * passes every rule because it reads perfectly.
   *
   * Two settings and not one, deliberately. The rules are free and instant; the
   * judge is a second call on every verified request, whether or not it finds
   * anything. Conflating them is how a cheap feature quietly becomes an
   * expensive one, so the caller has to ask for the expensive half by name.
   */
  verify?: boolean | "deep";
  /**
   * Send this call to a named provider, whatever selection would prefer.
   *
   * Exists for the independent judge: the whole point of choosing a different
   * family is undone if the check then goes wherever routing normally sends it.
   * Gates are unaffected, because they run after this and on every call.
   * Ignored when the named provider is absent or cannot serve the tier, so a
   * stale pin degrades to normal routing rather than to a failure.
   */
  provider_pin?: string;
}

export interface AICompleteResponse {
  content: string;
  model_used: string;
  provider_used: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

export interface AIProvider {
  readonly name: string;
  supportsTier(tier: AIModelTier): boolean;
  complete(req: AICompleteRequest): Promise<AICompleteResponse>;
}

export interface AIClient {
  complete(req: AICompleteRequest): Promise<AICompleteResponse>;
}

export class NoProviderAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderAvailableError";
  }
}

/**
 * Thrown by the router when a request's workspace has exceeded its
 * monthly_budget_usd cap. This is a GRACEFUL refusal, not a 5xx: the router
 * never dispatched to a provider, so no model was charged. Distinct
 * name + status (402 Payment Required) let call sites translate it into a
 * clear "AI budget exceeded for this workspace" message instead of a generic
 * 500. Carries the numbers behind the decision for surfacing + auditing.
 */
export class BudgetExceededError extends Error {
  readonly name = "BudgetExceededError";
  /** HTTP-shaped hint so route handlers map this to 402, not 500. */
  readonly status = 402;
  constructor(
    message: string,
    public readonly details: {
      workspace_id: string;
      month_spend_usd: number;
      budget_usd: number;
      feature: string;
    },
  ) {
    super(message);
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
