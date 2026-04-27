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
 *   2. generateDraftResponse(ticket, patterns) — async. Calls Claude
 *      Sonnet with a system prompt that instructs it to draft a clear,
 *      friendly response, reference the matched templates, and avoid
 *      em dashes. Result is cached by sha256(body + pattern ids) so
 *      a retry never re-bills the model.
 *
 * Caching: the spec asks for `instinct_kv_cache` if present, otherwise
 * an in-memory Map + TODO. The Map lives at module scope so it survives
 * across calls in the same process; serverless cold-starts will miss,
 * which is acceptable for the cost profile.
 */

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import type {
  CreateTicketInput,
  MatchSignature,
  SupportPattern,
  SupportTicket,
} from "./types";
import { isMatchSignature } from "./types";

export const SUPPORT_DRAFT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Anthropic client (singleton, opt-in via env var)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 2,
    });
  }
  return _client;
}

export function isDraftGeneratorAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
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

interface CacheEntry {
  draft: string;
  cached_at: number;
}

// TODO: persist to instinct_kv_cache when that table is introduced. Until
// then we use a process-local Map; cold starts on Vercel will repopulate.
const draftCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheKeyFor(body: string, patternIds: string[]): string {
  const ids = [...patternIds].sort().join(",");
  return createHash("sha256").update(`${body}::${ids}`).digest("hex");
}

export function _resetDraftCacheForTests(): void {
  draftCache.clear();
}

// ---------------------------------------------------------------------------
// Draft generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a Wolfpack support specialist drafting an email response to a user.",
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
  const key = cacheKeyFor(input.ticket.body, patternIds);

  const cached = draftCache.get(key);
  if (cached && Date.now() - cached.cached_at < CACHE_TTL_MS) {
    return {
      ok: true,
      draft: cached.draft,
      pattern_ids: patternIds,
      from_cache: true,
      tokens_used: 0,
    };
  }

  const client = getClient();
  if (!client) {
    return {
      ok: false,
      error_detail: "ANTHROPIC_API_KEY not set",
      pattern_ids: patternIds,
    };
  }

  try {
    const response = await client.messages.create({
      model: SUPPORT_DRAFT_MODEL,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input.ticket, input.matchingPatterns),
        },
      ],
    });

    const text = response.content
      .filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      )
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text) {
      return {
        ok: false,
        error_detail: "claude returned no text blocks",
        pattern_ids: patternIds,
      };
    }

    draftCache.set(key, { draft: text, cached_at: Date.now() });

    const tokens =
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0) +
      (response.usage?.cache_creation_input_tokens ?? 0) +
      (response.usage?.cache_read_input_tokens ?? 0);

    return {
      ok: true,
      draft: text,
      pattern_ids: patternIds,
      from_cache: false,
      tokens_used: tokens,
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return {
        ok: false,
        error_detail: `anthropic_auth_error: ${err.message}`,
        pattern_ids: patternIds,
      };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return {
        ok: false,
        error_detail: `anthropic_rate_limited: ${err.message}`,
        pattern_ids: patternIds,
      };
    }
    if (err instanceof Anthropic.APIError) {
      return {
        ok: false,
        error_detail: `anthropic_api_error_${err.status}: ${err.message}`,
        pattern_ids: patternIds,
      };
    }
    return {
      ok: false,
      error_detail: `support_draft_unknown_error: ${(err as Error).message ?? String(err)}`,
      pattern_ids: patternIds,
    };
  }
}
