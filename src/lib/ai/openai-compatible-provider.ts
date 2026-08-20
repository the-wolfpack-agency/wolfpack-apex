/**
 * Any provider that speaks the OpenAI chat-completions shape, configured
 * rather than coded.
 *
 * THE GAP THIS CLOSES
 *
 * We reach ten models. The gateways we compete with advertise hundreds. That
 * number is not the achievement it looks like, because most of it is one wire
 * format repeated: Groq, Together, Fireworks, DeepSeek, Mistral, vLLM, Ollama
 * and a dozen others all serve POST /v1/chat/completions with the same request
 * and response bodies. A gateway with four hundred models mostly has one
 * adapter and a long configuration file.
 *
 * So this is that adapter, and the long file is environment configuration. A
 * new provider is a base URL, a key, and a model name. No new code, no new
 * dependency, no release.
 *
 * WHY NOT JUST CALL A GATEWAY AND INHERIT THEIR CATALOGUE
 *
 * Because the catalogue is the least valuable half of what we do. Routing
 * through somebody else's gateway means our redaction, residency and audit
 * would sit behind THEIR hop: the prompt reaches them before it reaches the
 * model, and "nothing leaves unchecked" stops being true at the first hop
 * rather than the last. Speaking the format directly keeps our gate the outer
 * layer, which is the entire product.
 *
 * WHAT MAKES A PROVIDER TRUSTWORTHY IS STILL A DECISION, NOT A CONNECTION
 *
 * A model being reachable says nothing about whether it may see personal data
 * or where it runs. Both remain what they were: a provider is eligible for
 * sensitive data only when AI_ZERO_RETENTION_PROVIDERS names it, and eligible
 * for a residency-bound request only when its region is declared. A provider
 * added here starts with neither, which is the correct starting position and
 * is deliberately inconvenient in the right direction.
 */
import type {
  AICompleteRequest,
  AICompleteResponse,
  AIModelTier,
  AIProvider,
} from "./types";

/** Per-provider settings, all read from the environment at call time. */
export interface CompatibleProviderConfig {
  /** Registry id, lowercase, e.g. "groq". Used in env var names. */
  id: string;
  /** Base URL, with or without a trailing /v1. */
  baseUrl: string;
  apiKey: string;
  /** Model name per tier, as the provider spells it. */
  models: Partial<Record<AIModelTier, string>>;
  /** USD per 1k tokens, per tier. Absent means cost is reported as 0 and the
   *  call is still made: a missing price must not silence a working model, and
   *  a zero that is visible is better than a guess that is not. */
  pricing: Partial<Record<AIModelTier, { inputPer1k: number; outputPer1k: number }>>;
}

const ENV_PREFIX = "AI_COMPAT_";

function envKey(id: string, suffix: string): string {
  return `${ENV_PREFIX}${id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

/**
 * Which compatible providers this deployment has been given.
 *
 * AI_COMPAT_PROVIDERS is a comma-separated list of ids. Each id then needs a
 * URL and a key, and at least one tier mapped to a model name. Anything
 * incompletely configured is SKIPPED rather than half-registered: a provider
 * that appears in a list and then fails at call time is worse than one that
 * never appeared, because the failure lands on a user instead of on whoever
 * was setting it up.
 */
export function configuredCompatibleProviders(
  env: Record<string, string | undefined> = process.env,
): CompatibleProviderConfig[] {
  const ids = (env[`${ENV_PREFIX}PROVIDERS`] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const out: CompatibleProviderConfig[] = [];
  for (const id of [...new Set(ids)]) {
    const baseUrl = env[envKey(id, "BASE_URL")]?.trim();
    const apiKey = env[envKey(id, "API_KEY")]?.trim();
    if (!baseUrl || !apiKey) continue;

    const models: CompatibleProviderConfig["models"] = {};
    const pricing: CompatibleProviderConfig["pricing"] = {};
    for (const tier of ["cheap", "standard", "premium"] as const) {
      const model = env[envKey(id, `MODEL_${tier.toUpperCase()}`)]?.trim();
      if (!model) continue;
      models[tier] = model;
      const inp = Number(env[envKey(id, `INPUT_PER_1K_${tier.toUpperCase()}`)]);
      const outp = Number(env[envKey(id, `OUTPUT_PER_1K_${tier.toUpperCase()}`)]);
      if (Number.isFinite(inp) && Number.isFinite(outp) && inp >= 0 && outp >= 0) {
        pricing[tier] = { inputPer1k: inp, outputPer1k: outp };
      }
    }
    if (Object.keys(models).length === 0) continue;
    out.push({ id, baseUrl, apiKey, models, pricing });
  }
  return out;
}

/** Join the base URL to the chat-completions path without doubling /v1. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export class CompatibleProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CompatibleProviderError";
  }
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * Read the response.
 *
 * Strict about the ONE thing that matters and forgiving about the rest: an
 * answer with no content is an error, because returning empty text as success
 * hands a user a blank box and calls it an answer. Missing usage counts are
 * tolerated and reported as zero, since plenty of self-hosted servers omit
 * them and a missing token count is not a reason to throw away a good answer.
 */
export function parseCompletion(raw: unknown): { content: string; inputTokens: number; outputTokens: number; model: string } {
  const body = (raw ?? {}) as ChatCompletionBody;
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new CompatibleProviderError("The provider returned no message content.", 502);
  }
  return {
    content,
    inputTokens: Number(body.usage?.prompt_tokens ?? 0) || 0,
    outputTokens: Number(body.usage?.completion_tokens ?? 0) || 0,
    model: typeof body.model === "string" ? body.model : "",
  };
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;

  constructor(private readonly config: CompatibleProviderConfig) {
    this.name = config.id;
  }

  supportsTier(tier: AIModelTier): boolean {
    return Boolean(this.config.models[tier]);
  }

  /** The model this provider would use for a tier, so a caller can judge its
   *  lineage before deciding whether it is an independent checker. */
  modelFor(tier: AIModelTier): string | undefined {
    return this.config.models[tier];
  }

  async complete(req: AICompleteRequest): Promise<AICompleteResponse> {
    const model = this.config.models[req.model_tier];
    if (!model) {
      throw new CompatibleProviderError(
        `${this.name} has no model configured for the ${req.model_tier} tier.`,
        500,
      );
    }

    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const started = Date.now();
    const res = await fetch(chatCompletionsUrl(this.config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature ?? 0.7,
      }),
    });

    if (!res.ok) {
      /* The provider's own message, never its body wholesale: an error body can
         echo the prompt back, and this string is logged. */
      throw new CompatibleProviderError(
        `${this.name} returned HTTP ${res.status}.`,
        res.status,
      );
    }

    const parsed = parseCompletion(await res.json());
    const price = this.config.pricing[req.model_tier];
    const cost = price
      ? (parsed.inputTokens / 1000) * price.inputPer1k +
        (parsed.outputTokens / 1000) * price.outputPer1k
      : 0;

    return {
      content: parsed.content,
      model_used: parsed.model || model,
      provider_used: this.name,
      input_tokens: parsed.inputTokens,
      output_tokens: parsed.outputTokens,
      cost_usd: cost,
      latency_ms: Date.now() - started,
    };
  }
}

/** Build a provider per configured id. Empty when none are configured. */
export function buildCompatibleProviders(
  env: Record<string, string | undefined> = process.env,
): OpenAICompatibleProvider[] {
  return configuredCompatibleProviders(env).map((c) => new OpenAICompatibleProvider(c));
}
