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
