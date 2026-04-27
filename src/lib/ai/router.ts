/**
 * src/lib/ai/router — single entry point for AI completions.
 *
 * Routing rules (today, anthropic-only):
 *   - If AZURE_OPENAI_ENDPOINT is unset, every request goes to Anthropic.
 *   - When Azure is configured, requests with sensitivity === 'phi' go
 *     to Azure (BAA-covered); everything else stays on Anthropic.
 *
 * Failover:
 *   - On 5xx-class errors from the primary, fall back to Anthropic when
 *     a different provider is available. Track the fallback in analytics
 *     and on the response (`provider_used`).
 *   - If no fallback is available the original error propagates to the
 *     caller; `console.warn` records the failure.
 *
 * Cost tracking:
 *   - Every successful call emits `ai.completion` to the analytics
 *     pipeline. trackEvent is fire-and-forget and never blocks.
 */

import { trackEvent } from "@/lib/analytics";

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
import { NoProviderAvailableError } from "./types";

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

function pickPrimary(
  req: AICompleteRequest,
  registry: ProviderRegistry,
): AIProvider {
  if (isAzureConfigured() && req.sensitivity === "phi") {
    return registry.azure;
  }
  return registry.anthropic;
}

function pickFallback(
  primary: AIProvider,
  registry: ProviderRegistry,
): AIProvider | null {
  if (primary === registry.anthropic) return null;
  return registry.anthropic;
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

class RouterClient implements AIClient {
  constructor(private readonly registry: ProviderRegistry) {}

  async complete(req: AICompleteRequest): Promise<AICompleteResponse> {
    const primary = pickPrimary(req, this.registry);
    let response: AICompleteResponse;
    let fallbackUsed = false;

    try {
      response = await primary.complete(req);
    } catch (err) {
      const fallback = pickFallback(primary, this.registry);
      if (fallback && isRetryableError(err)) {
        console.warn(
          `[ai/router] primary ${primary.name} failed (${(err as Error).message}); falling back to ${fallback.name}`,
        );
        response = await fallback.complete(req);
        fallbackUsed = true;
      } else {
        console.warn(
          `[ai/router] ${primary.name} failed with no usable fallback: ${(err as Error).message}`,
        );
        throw err;
      }
    }

    emitCompletionEvent(req, response, fallbackUsed);
    return response;
  }
}

function emitCompletionEvent(
  req: AICompleteRequest,
  response: AICompleteResponse,
  fallbackUsed: boolean,
): void {
  const feature = req.metadata?.feature ?? "unknown";
  const userId = req.metadata?.user_id ?? "system";
  const userRole = req.metadata?.user_role ?? "system";
  const metadata: Record<string, string | number | boolean> = {
    feature,
    provider: response.provider_used,
    model: response.model_used,
    tier: req.model_tier,
    input_tokens: response.input_tokens,
    output_tokens: response.output_tokens,
    cost_usd: response.cost_usd,
    latency_ms: response.latency_ms,
    fallback_used: fallbackUsed,
  };
  if (req.sensitivity) metadata.sensitivity = req.sensitivity;
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

export { NoProviderAvailableError };
