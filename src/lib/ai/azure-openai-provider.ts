/**
 * src/lib/ai/azure-openai-provider — Azure OpenAI Chat Completions adapter.
 *
 * Uses raw fetch (no @azure/openai SDK) against:
 *   POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}/chat/completions
 *      ?api-version=2024-08-01-preview
 *
 * Required env (set in Vercel production):
 *   AZURE_OPENAI_ENDPOINT       https://YOUR_RESOURCE.openai.azure.com (no trailing slash)
 *   AZURE_OPENAI_API_KEY        Key 1 or Key 2 from Azure portal -> Resource -> Keys and Endpoint
 * Optional env (defaults to standard model names):
 *   AZURE_OPENAI_DEPLOYMENT_CHEAP     default 'gpt-4o-mini'
 *   AZURE_OPENAI_DEPLOYMENT_STANDARD  default 'gpt-4o'
 *   AZURE_OPENAI_DEPLOYMENT_PREMIUM   default 'gpt-4'
 * Optional env:
 *   AI_PROVIDER_PRIMARY  'azure-openai' | 'anthropic' | 'auto' (default 'auto')
 * Free tier note: Azure offers $200 free credits for new accounts (30 days).
 * For ongoing free use after credits, consider Azure AI Foundry's free model
 * garden (Llama, Mistral) — different SDK path, would need a separate adapter.
 */

import type {
  AICompleteRequest,
  AICompleteResponse,
  AIMessage,
  AIModelTier,
  AIProvider,
} from "./types";

const DEFAULT_TIER_TO_DEPLOYMENT: Record<AIModelTier, string> = {
  cheap: "gpt-4o-mini",
  standard: "gpt-4o",
  premium: "gpt-4",
};

const TIER_DEPLOYMENT_ENV: Record<AIModelTier, string> = {
  cheap: "AZURE_OPENAI_DEPLOYMENT_CHEAP",
  standard: "AZURE_OPENAI_DEPLOYMENT_STANDARD",
  premium: "AZURE_OPENAI_DEPLOYMENT_PREMIUM",
};

const API_VERSION = "2024-08-01-preview";

interface TierPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

/* Pricing per million tokens. Hardcoded today; when a billing service
   lands the router can override. Numbers reflect Azure OpenAI list
   prices for the named base model families. */
const TIER_PRICING: Record<AIModelTier, TierPricing> = {
  cheap: { input_per_mtok: 0.15, output_per_mtok: 0.6 },
  standard: { input_per_mtok: 2.5, output_per_mtok: 10 },
  premium: { input_per_mtok: 10, output_per_mtok: 30 },
};

interface AzureChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AzureChatChoice {
  index?: number;
  message?: { role?: string; content?: string };
  finish_reason?: string;
}

interface AzureChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface AzureChatResponse {
  id?: string;
  choices?: AzureChatChoice[];
  usage?: AzureChatUsage;
  model?: string;
}

interface AzureErrorBody {
  error?: { code?: string; message?: string };
}

export class AzureProviderError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AzureProviderError";
    this.status = status;
  }
}

// TODO: swap to getSecret("azure-openai-*") from src/lib/secrets.ts
// once that wrapper lands. Until then, read directly from env.
function readEndpoint(): string | null {
  const raw = process.env.AZURE_OPENAI_ENDPOINT;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function readApiKey(): string | null {
  return process.env.AZURE_OPENAI_API_KEY ?? null;
}

function readDeploymentName(tier: AIModelTier): string {
  const envKey = TIER_DEPLOYMENT_ENV[tier];
  const override = process.env[envKey];
  if (override && override.length > 0) return override;
  return DEFAULT_TIER_TO_DEPLOYMENT[tier];
}

export function isAzureConfigured(): boolean {
  return Boolean(readEndpoint() && readApiKey());
}

function toAzureMessages(req: AICompleteRequest): AzureChatMessage[] {
  const out: AzureChatMessage[] = [];
  if (req.system && req.system.length > 0) {
    out.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) {
    out.push(toAzureMessage(m));
  }
  return out;
}

function toAzureMessage(m: AIMessage): AzureChatMessage {
  if (m.role === "assistant") return { role: "assistant", content: m.content };
  if (m.role === "system") return { role: "system", content: m.content };
  return { role: "user", content: m.content };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return res.statusText || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as AzureErrorBody;
      if (parsed?.error?.message) return parsed.error.message;
    } catch {
      // not JSON, fall through and use the text body
    }
    return text;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

export class AzureOpenAIProvider implements AIProvider {
  readonly name = "azure-openai";

  supportsTier(_tier: AIModelTier): boolean {
    return isAzureConfigured();
  }

  async complete(req: AICompleteRequest): Promise<AICompleteResponse> {
    const endpoint = readEndpoint();
    const apiKey = readApiKey();
    if (!endpoint || !apiKey) {
      throw new AzureProviderError(
        "Azure OpenAI not configured: set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY",
        500,
      );
    }

    const deployment = readDeploymentName(req.model_tier);
    const pricing = TIER_PRICING[req.model_tier];
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(
      deployment,
    )}/chat/completions?api-version=${API_VERSION}`;

    const body = {
      messages: toAzureMessages(req),
      max_tokens: req.max_tokens,
      temperature: req.temperature ?? 0.7,
    };

    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure: surface as 5xx so the router treats it as
      // retryable and falls back to Anthropic.
      const message = err instanceof Error ? err.message : String(err);
      throw new AzureProviderError(
        `Azure OpenAI network error: ${message}`,
        503,
      );
    }
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      const detail = await readErrorMessage(res);
      throw new AzureProviderError(
        `Azure OpenAI ${res.status}: ${detail}`,
        res.status,
      );
    }

    let parsed: AzureChatResponse;
    try {
      parsed = (await res.json()) as AzureChatResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AzureProviderError(
        `Azure OpenAI returned non-JSON response: ${message}`,
        502,
      );
    }

    const content = (parsed.choices?.[0]?.message?.content ?? "").trim();
    const input_tokens = parsed.usage?.prompt_tokens ?? 0;
    const output_tokens = parsed.usage?.completion_tokens ?? 0;
    const cost_usd =
      (input_tokens / 1_000_000) * pricing.input_per_mtok +
      (output_tokens / 1_000_000) * pricing.output_per_mtok;

    return {
      content,
      model_used: deployment,
      provider_used: this.name,
      input_tokens,
      output_tokens,
      cost_usd,
      latency_ms,
    };
  }
}

export const AZURE_TIER_TO_DEPLOYMENT = DEFAULT_TIER_TO_DEPLOYMENT;
export const AZURE_TIER_PRICING = TIER_PRICING;
