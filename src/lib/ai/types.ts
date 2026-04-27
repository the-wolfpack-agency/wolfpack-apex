/**
 * src/lib/ai/types — provider-neutral shapes for the AI abstraction.
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

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
