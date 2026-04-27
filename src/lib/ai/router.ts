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
      response = await primary.complete(req);
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
      const fallback = pickFallback(primary, this.registry);
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
          response = await fallback.complete(req);
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
