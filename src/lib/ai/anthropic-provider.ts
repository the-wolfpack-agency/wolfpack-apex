/**
 * src/lib/ai/anthropic-provider — Anthropic SDK adapter for the AI
 * abstraction layer. Maps the provider-neutral tier names onto current
 * Claude model ids and computes cost from the per-MTok pricing table.
 *
 * Pricing table is hardcoded today; when a billing service lands the
 * router can override it. Pricing is in USD per million tokens.
 */

import Anthropic from "@anthropic-ai/sdk";
import { guardedFetch } from "@/lib/containment/guarded-fetch";

import type {
  AICompleteRequest,
  AICompleteResponse,
  AIModelTier,
  AIProvider,
} from "./types";

const TIER_TO_MODEL: Record<AIModelTier, string> = {
  cheap: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  premium: "claude-opus-4-7",
};

interface TierPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

const TIER_PRICING: Record<AIModelTier, TierPricing> = {
  cheap: { input_per_mtok: 1, output_per_mtok: 5 },
  standard: { input_per_mtok: 3, output_per_mtok: 15 },
  premium: { input_per_mtok: 15, output_per_mtok: 75 },
};

// TODO: swap to getSecret("anthropic-api-key") from src/lib/secrets.ts
// once that wrapper lands. Until then, read directly from env.
function readApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";

  private clientCache: Anthropic | null = null;

  supportsTier(_tier: AIModelTier): boolean {
    return true;
  }

  private getClient(): Anthropic {
    if (this.clientCache) return this.clientCache;
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }
    // The SDK does its own fetching, so the allowlist goes in as its fetch.
    // Same rule as the Azure provider, one implementation, no second copy.
    this.clientCache = new Anthropic({ apiKey, maxRetries: 0, fetch: guardedFetch("model-api") });
    return this.clientCache;
  }

  async complete(req: AICompleteRequest): Promise<AICompleteResponse> {
    const model = TIER_TO_MODEL[req.model_tier];
    const pricing = TIER_PRICING[req.model_tier];
    const client = this.getClient();

    const start = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: req.max_tokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    });
    const latency_ms = Date.now() - start;

    const text = response.content
      .filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      )
      .map((b) => b.text)
      .join("")
      .trim();

    const input_tokens = response.usage?.input_tokens ?? 0;
    const output_tokens = response.usage?.output_tokens ?? 0;
    const cost_usd =
      (input_tokens / 1_000_000) * pricing.input_per_mtok +
      (output_tokens / 1_000_000) * pricing.output_per_mtok;

    return {
      content: text,
      model_used: response.model ?? model,
      provider_used: this.name,
      input_tokens,
      output_tokens,
      cost_usd,
      latency_ms,
    };
  }
}

export const ANTHROPIC_TIER_TO_MODEL = TIER_TO_MODEL;
export const ANTHROPIC_TIER_PRICING = TIER_PRICING;
