/**
 * support / pattern-library — match incoming ticket text against the
 * curated pattern library and generate an AI draft response.
 *
 * Two responsibilities:
 *
 *   1. findMatchingPatterns(text, patterns) — pure function. Compiles
 *      each pattern's match_signatures and returns matches sorted by
 *      net feedback score (success - fail) descending. No I/O.
 *
 *   2. generateDraftResponse(ticket, patterns) — async. Calls the
 *      provider-neutral AI client (src/lib/ai) at standard tier with a
 *      system prompt that instructs the model to draft a clear,
 *      friendly response, reference the matched templates, and avoid
 *      em dashes. The persistent response cache (src/lib/ai/response-cache)
 *      is consulted FIRST: a strong lexical match returns the previously
 *      generated draft without burning new tokens. Only on a miss do we
 *      call the provider, and on success we write the result back to the
 *      cache so future similar tickets are free.
 *
 * Caching: persistent. Backed by `instinct_support_response_cache` (see
 * migration 105). Replaces the previous process-local Map; cold starts
 * on Vercel no longer lose the cache. Quality-gated — a cached draft the
 * operator voted unhelpful is no longer served, the next request burns
 * fresh tokens and writes a new row.
 */

import { createHash } from "node:crypto";

import { getAIClient } from "@/lib/ai";
import {
  cacheResponse,
  lookupCachedResponse,
} from "@/lib/ai/response-cache";

import type {
  CreateTicketInput,
  MatchSignature,
  SupportPattern,
  SupportTicket,
} from "./types";
import { isMatchSignature } from "./types";

export const SUPPORT_DRAFT_MODEL = "claude-sonnet-4-6";

export function isDraftGeneratorAvailable(): boolean {
  // Provider availability is now resolved by the AI router, which checks
  // every configured backend (Anthropic, Azure OpenAI, Foundry). The
  // legacy ANTHROPIC_API_KEY-only check incorrectly short-circuited the
  // draft path when we were running Azure-only. Any configured provider
  // is enough; the router throws NoProviderAvailableError if none are.
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.AZURE_OPENAI_ENDPOINT ||
      process.env.AZURE_OPENAI_API_KEY,
  );
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchOne(text: string, sig: MatchSignature): boolean {
  if (sig.type === "regex") {
    try {
      return new RegExp(sig.pattern, sig.flags ?? "").test(text);
    } catch {
      // Invalid regex in DB row should not crash matching. The pattern
      // is effectively disabled until an operator fixes the row.
      return false;
    }
  }
  if (sig.type === "substring") {
    if (sig.case_insensitive) {
      return text.toLowerCase().includes(sig.pattern.toLowerCase());
    }
    return text.includes(sig.pattern);
  }
  return false;
}

/**
 * Run every enabled pattern's signatures against `text`. A pattern
 * matches when ANY of its signatures hit (OR semantics). Returns
 * matches sorted by `success_count - fail_count` desc.
 */
export function findMatchingPatterns(
  text: string,
  patterns: ReadonlyArray<SupportPattern>,
): SupportPattern[] {
  if (!text) return [];
  const matches: SupportPattern[] = [];
  for (const p of patterns) {
    if (!p.enabled) continue;
    const sigs = Array.isArray(p.match_signatures)
      ? p.match_signatures.filter(isMatchSignature)
      : [];
    if (sigs.length === 0) continue;
    if (sigs.some((s) => matchOne(text, s))) {
      matches.push(p);
    }
  }
  return matches.sort(
    (a, b) =>
      b.success_count - b.fail_count - (a.success_count - a.fail_count),
  );
}

// ---------------------------------------------------------------------------
// Draft response cache
// ---------------------------------------------------------------------------
//
// The persistent cache lives in instinct_support_response_cache (migration
// 105) and is reached through src/lib/ai/response-cache. The legacy
// in-memory Map was deleted as part of that work — every cache decision
// now goes through the DB so cold starts on Vercel don't lose savings.
//
// `cacheKeyFor` is preserved as a pure helper for backwards compatibility
// with any caller that wants a deterministic key from (body, pattern_ids)
// — the in-memory store is gone but the hash itself is still useful for
// debugging cache collisions in tests.

export function cacheKeyFor(body: string, patternIds: string[]): string {
  const ids = [...patternIds].sort().join(",");
  return createHash("sha256").update(`${body}::${ids}`).digest("hex");
}

/**
 * Test-only no-op kept for backwards compatibility with existing tests
 * that called this in beforeEach. The persistent cache lives in Postgres
 * now and tests mock @/lib/ai/response-cache directly, so there is
 * nothing to clear here.
 */
export function _resetDraftCacheForTests(): void {
  /* no-op — cache is persistent now; tests mock the cache module. */
}

// ---------------------------------------------------------------------------
// Draft generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a Wolfpack support specializt drafting an email response to a user.",
  "Draft a clear, friendly response. Reference the matched troubleshooting patterns provided.",
  "Use the customer's first name if it is known from the ticket. Otherwise greet them as 'there'.",
  "Do not use em dashes anywhere in the response.",
  "Sign off as 'The Wolfpack Team'.",
  "Keep the response concise and actionable. Use a numbered list when there are explicit steps.",
  "Output the email body only. No subject line. No commentary outside the email.",
].join("\n");

export interface GenerateDraftInput {
  ticket: Pick<SupportTicket, "title" | "body" | "diagnostic_text" | "created_by_email">
    | (CreateTicketInput & { created_by_email?: string | null });
  matchingPatterns: ReadonlyArray<SupportPattern>;
}

export interface GenerateDraftResult {
  ok: true;
  draft: string;
  pattern_ids: string[];
  from_cache: boolean;
  tokens_used: number;
  /**
   * Cache row id this draft was either served from (cache hit) or saved
   * into (cache miss). Stored on the ticket's cache_ids JSONB so the
   * feedback handler can propagate operator votes back to the cache.
   * `null` only when persistence failed; the draft itself is still
   * valid.
   */
  cache_id: string | null;
  /** Provider attribution. 'cache' on a hit, otherwise the upstream
   *  provider name (e.g. 'anthropic' / 'azure-openai'). */
  provider_used: string;
}

export interface GenerateDraftFailure {
  ok: false;
  error_detail: string;
  pattern_ids: string[];
}

export type GenerateDraftOutcome = GenerateDraftResult | GenerateDraftFailure;

/**
 * Build the user-prompt body. Exposed for unit tests so we can assert
 * the matched templates are forwarded verbatim and the diagnostic_text
 * is included.
 */
export function buildUserPrompt(
  ticket: GenerateDraftInput["ticket"],
  patterns: ReadonlyArray<SupportPattern>,
): string {
  const parts: string[] = [];
  parts.push(`Ticket title: ${ticket.title}`);
  parts.push("");
  parts.push("Ticket body:");
  parts.push(ticket.body);
  if (ticket.diagnostic_text) {
    parts.push("");
    parts.push("Diagnostic text pasted by the operator:");
    parts.push(ticket.diagnostic_text);
  }
  if (ticket.created_by_email) {
    parts.push("");
    parts.push(`Operator who filed the ticket: ${ticket.created_by_email}`);
  }
  if (patterns.length > 0) {
    parts.push("");
    parts.push("Matched troubleshooting patterns (use these as the basis for your reply):");
    for (const p of patterns) {
      parts.push("");
      parts.push(`### ${p.name} (${p.slug})`);
      parts.push(p.draft_template);
    }
  } else {
    parts.push("");
    parts.push("No patterns matched in our library. Draft a polite holding reply that asks the user for the exact error text and a screenshot.");
  }
  return parts.join("\n");
}

export async function generateDraftResponse(
  input: GenerateDraftInput,
): Promise<GenerateDraftOutcome> {
  const patternIds = input.matchingPatterns.map((p) => p.id);

  /* Persistent cache lookup. Returns a hit only when the same
     conceptual ticket has been drafted before AND the operator has not
     voted it down. Failures inside the cache module fall through to a
     miss — the cache must never block a draft from being generated. */
  try {
    const lookup = await lookupCachedResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: input.ticket.title,
        body: input.ticket.body,
        diagnostic_text: input.ticket.diagnostic_text ?? null,
        pattern_ids: patternIds,
      },
    });
    if (lookup.hit) {
      return {
        ok: true,
        draft: lookup.cached.content,
        pattern_ids: patternIds,
        from_cache: true,
        tokens_used: 0,
        cache_id: lookup.cache_id,
        provider_used: "cache",
      };
    }
  } catch {
    /* lookupCachedResponse already swallows + logs; this is just
       belt-and-braces in case a future change makes it throw. */
  }

  if (!isDraftGeneratorAvailable()) {
    return {
      ok: false,
      error_detail: "ANTHROPIC_API_KEY not set",
      pattern_ids: patternIds,
    };
  }

  try {
    const response = await getAIClient().complete({
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input.ticket, input.matchingPatterns),
        },
      ],
      system: SYSTEM_PROMPT,
      max_tokens: 2048,
      model_tier: "standard",
      sensitivity: "public",
      metadata: { feature: "support.draft" },
    });

    const text = response.content.trim();
    if (!text) {
      return {
        ok: false,
        error_detail: "claude returned no text blocks",
        pattern_ids: patternIds,
      };
    }

    /* Persist to the cache so future similar tickets are free. Failure
       here logs via obs but does not fail the draft — the operator
       still gets the response we just paid for. */
    let cacheId: string | null = null;
    try {
      const written = await cacheResponse({
        feature: "support.draft",
        input: {
          feature: "support.draft",
          title: input.ticket.title,
          body: input.ticket.body,
          diagnostic_text: input.ticket.diagnostic_text ?? null,
          pattern_ids: patternIds,
        },
        response: { ...response, content: text },
      });
      cacheId = written.cache_id || null;
    } catch {
      /* swallowed by cacheResponse already; defensive double-catch. */
    }

    const tokens = response.input_tokens + response.output_tokens;

    return {
      ok: true,
      draft: text,
      pattern_ids: patternIds,
      from_cache: false,
      tokens_used: tokens,
      cache_id: cacheId,
      provider_used: response.provider_used,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: unknown }).status;
    if (status === 401) {
      return {
        ok: false,
        error_detail: `anthropic_auth_error: ${message}`,
        pattern_ids: patternIds,
      };
    }
    if (status === 429) {
      return {
        ok: false,
        error_detail: `anthropic_rate_limited: ${message}`,
        pattern_ids: patternIds,
      };
    }
    if (typeof status === "number") {
      return {
        ok: false,
        error_detail: `anthropic_api_error_${status}: ${message}`,
        pattern_ids: patternIds,
      };
    }
    return {
      ok: false,
      error_detail: `support_draft_unknown_error: ${message}`,
      pattern_ids: patternIds,
    };
  }
}
