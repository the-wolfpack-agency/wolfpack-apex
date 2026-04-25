/**
 * meeting-insights / analyzer / anthropic — thin Anthropic SDK wrapper.
 *
 * Single responsibility: send a (system, user) pair to Claude Haiku and
 * return the raw text + usage. All schema parsing happens in
 * `analyzer/index.ts`; this module is dumb pipe.
 *
 * Hard rules:
 *   - Never throws. Missing API key, network errors, rate-limits → all
 *     surface as `{ status: "error", error_detail }` so ingest never
 *     dies because the model is offline.
 *   - Prompt caching ON. The system prompt + JSON schema are stable and
 *     cached with `cache_control: ephemeral`; the per-message body is
 *     the only varying portion. With 5-min TTL we get >90% cache reads
 *     when ingesting a feed in bulk.
 *   - Single-shot, no streaming. Haiku is fast enough that a 16K-token
 *     non-streaming response stays under SDK timeout, and streaming
 *     adds complexity for no real-time UX gain (analysis fires async
 *     post-ingest, the UI polls).
 *
 * Token-budget rule (per memory feedback_zero_tokens_first): the system
 * prompt encodes the structured schema so the model returns JSON
 * directly — we don't pay for tool-calling overhead.
 */

import Anthropic from "@anthropic-ai/sdk";

import { ANALYZER_MODEL } from "./types";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Singleton client. The SDK is happy to be re-instantiated, but we
 * dedupe so connection pools / retries / streaming agents are shared
 * across many concurrent ingest hooks.
 */
let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Server-side; no dangerouslyAllowBrowser.
      maxRetries: 2,
    });
  }
  return _client;
}

export function isAnalyzerAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface AnthropicCallSuccess {
  ok: true;
  text: string;
  model: string;
  tokens_used: number;
}

export interface AnthropicCallFailure {
  ok: false;
  error_detail: string;
}

export type AnthropicCallResult = AnthropicCallSuccess | AnthropicCallFailure;

export interface AnthropicCallInput {
  /** Stable instructions + JSON schema. Cached. */
  system_prompt: string;
  /** Per-message body (subject + body_text + attachment text). NOT cached. */
  user_prompt: string;
  /** Optional override (defaults to claude-haiku-4-5). */
  model?: string;
  /** Optional override (defaults to 8192). */
  max_tokens?: number;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Send a single (system, user) pair to Claude Haiku.
 *
 * Prompt caching: we put `cache_control: ephemeral` on the LAST block
 * of the system prompt. Per the API docs, render order is
 * `tools → system → messages`, so a marker on the final system block
 * caches the whole stable preamble. The user message is volatile and
 * deliberately uncached.
 */
export async function callAnthropic(
  input: AnthropicCallInput,
): Promise<AnthropicCallResult> {
  const client = getClient();
  if (!client) {
    return {
      ok: false,
      error_detail: "ANTHROPIC_API_KEY not set",
    };
  }

  const model = input.model ?? ANALYZER_MODEL;
  const maxTokens = input.max_tokens ?? 8192;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // System prompt as an array of blocks so we can attach
      // cache_control to the last block. The Anthropic SDK accepts
      // either a string or an array here; arrays are required for
      // explicit cache breakpoints.
      system: [
        {
          type: "text",
          text: input.system_prompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: input.user_prompt,
        },
      ],
    });

    // Extract text from the response blocks.
    const text = response.content
      .filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      )
      .map((block) => block.text)
      .join("");

    if (!text) {
      return {
        ok: false,
        error_detail: "claude returned no text blocks",
      };
    }

    const tokens =
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0) +
      (response.usage?.cache_creation_input_tokens ?? 0) +
      (response.usage?.cache_read_input_tokens ?? 0);

    return {
      ok: true,
      text,
      model: response.model ?? model,
      tokens_used: tokens,
    };
  } catch (err) {
    // Typed error narrowing per the SDK guidance — never string-match.
    if (err instanceof Anthropic.AuthenticationError) {
      return {
        ok: false,
        error_detail: `anthropic_auth_error: ${err.message}`,
      };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return {
        ok: false,
        error_detail: `anthropic_rate_limited: ${err.message}`,
      };
    }
    if (err instanceof Anthropic.APIError) {
      return {
        ok: false,
        error_detail: `anthropic_api_error_${err.status}: ${err.message}`,
      };
    }
    return {
      ok: false,
      error_detail: `analyzer_unknown_error: ${(err as Error).message ?? String(err)}`,
    };
  }
}
