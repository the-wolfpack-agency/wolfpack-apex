/**
 * src/lib/ai/response-cache — persistent AI response cache.
 *
 * Goal: previously-generated AI solutions are reused instead of
 * regenerated. Tokens are spent once on novel work; everything similar
 * after that is free forever (Nick's invariant: tokens for novel work,
 * codified tooling for everything seen before).
 *
 * Three public functions:
 *
 *   1. lookupCachedResponse — feature + input → either a cached
 *      AICompleteResponse (with provider_used = 'cache') or a miss.
 *      Lexical match only in this PR; semantic embedding fallback is
 *      reserved for Phase 2.
 *
 *   2. cacheResponse — feature + input + AI response → upserts the row,
 *      returns the cache id for the caller to record on the ticket.
 *
 *   3. recordCacheFeedback — cache id + helpful boolean → bumps the
 *      helpful_count or unhelpful_count counter. The lookup helper
 *      refuses to serve rows whose unhelpful balance exceeds helpful, so
 *      a bad cached response stops poisoning future requests once the
 *      operator votes.
 *
 * Failure mode: every public function wraps its DB calls in try/catch.
 * Cache failures NEVER block the caller — a thrown DB error logs via
 * obs.recordError and falls through to a miss / no-op, so the AI feature
 * just calls the provider as if the cache did not exist. The whole point
 * of the cache is to save tokens; a broken cache must not break support.
 */

import { createHash } from "node:crypto";

import { trackEvent } from "@/lib/analytics";
import { query, writeQuery } from "@/lib/db";
import { getObsClient } from "@/lib/obs";

import type { AICompleteResponse } from "./types";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which AI feature is requesting the cache. Stored in the `feature`
 * column. Kept as a TS literal union so call sites can't typo a feature
 * name into the table.
 */
export type CacheFeature =
  | "support.draft"
  | "support.categorize"
  | "support.auto_ack";

/**
 * Per-feature input shapes. Kept narrow per feature so the signature
 * helper can normalize the right pieces — same conceptual ticket should
 * collide on the signature even when names + timestamps differ. The
 * `support.draft` shape includes pattern_ids so the same ticket text
 * with different matched patterns produces a different cache key.
 */
export type CacheInput =
  | {
      feature: "support.draft";
      title: string;
      body: string;
      diagnostic_text?: string | null;
      pattern_ids: string[];
    }
  | {
      feature: "support.categorize";
      title: string;
      body: string;
      diagnostic_text?: string | null;
    }
  | {
      feature: "support.auto_ack";
      title: string;
      body: string;
      pattern_id: string;
    };

export interface LookupArgs {
  feature: CacheFeature;
  input: CacheInput;
}

export type LookupResult =
  | { hit: true; cached: AICompleteResponse; cache_id: string }
  | { hit: false };

export interface CacheResponseArgs {
  feature: CacheFeature;
  input: CacheInput;
  response: AICompleteResponse;
  /**
   * If provided (from a prior hit), bumps hit_count + last_used_at on the
   * existing row instead of upserting. Lets the call site keep the cache
   * "warm" without rewriting the cached response.
   */
  cache_id?: string;
}

export interface CacheResponseResult {
  cache_id: string;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/* Regexes used by normalizeForSignature. Defined at module scope so
   they're compiled once. Order matters: emails before UUIDs before
   ISO timestamps + names (those run before lowercasing) before phones
   + clock times (those run after), since some patterns can overlap. */
/* ReDoS-hardened (CodeQL js/polynomial-redos). The unbounded `+`
   quantifiers in `[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}` make this
   polynomial: on a long run with no `@`, the engine rescans the local
   part from every start position (O(n^2)). RFC 5321 already bounds the
   local part to 64 chars and a domain to 255, so cap the quantifiers -
   real addresses still match, adversarial digit/letter runs can't drive
   the engine past a fixed per-position bound. */
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gi;
/* Phone numbers cover the common North American and E.164 shapes.
   Anchored on a leading word boundary so we don't snip out pieces of
   UUIDs or sign-in error codes (those are stripped earlier in the
   pipeline anyway). The single allowed separator class `[\s.()-]` is
   non-overlapping with the digit class, keeping the matcher linear and
   defeating polynomial backtracking on adversarial digit-heavy input. */
/* ReDoS-hardened (CodeQL js/polynomial-redos). The prior form
   `(?:\+?\d{1,3}[\s.()-]{0,2})?(?:\(\d{3}\)|\d{3})[\s.()-]{0,2}\d{3}...`
   let the optional bare-digit country code AND the bare area code both
   compete for the leading digits of a long all-digit run, with optional
   `{0,2}` separators between every group - polynomial backtracking that
   burned ~800ms on 16 KiB of digits. Two changes linearise it without
   losing the real shapes:
     1. The optional country code now REQUIRES a leading `+` and a
        following separator, so a bare digit run can't be parsed as one.
     2. A bare (non-parenthesised) area code now REQUIRES a following
        separator; only the `(NNN)` form may abut the next group. This
        breaks the all-digit chain so the engine can't try N partitions.
   Real shapes "(555) 123-4567" and "+1 555-987-6543" still normalize
   identically (see response-cache.test.ts "strips phone numbers").
   Left boundary is a negative lookbehind (?<!\d) because \b fails before "(". */
const PHONE_RE =
  /(?<!\d)(?:\+\d{1,3}[\s.()-]{1,2})?(?:\(\d{3}\)[\s.()-]{0,2}|\d{3}[\s.()-]{1,2})\d{3}[\s.()-]{1,2}\d{4}(?!\d)/g;
/* Person-name heuristic: strip standalone capitalized tokens (Title-
   case, not all-caps acronyms like CEO/MFA/AADSTS). This must run
   before lowercasing. Imperfect by design — false positives just
   shrink the cache key slightly; false negatives (an unstripped name)
   prevent a cache hit but never produce an incorrect hit. We strip
   regardless of position in the sentence; that means a sentence-
   leading common word like "Yesterday" also gets stripped, which is
   fine since the date-word regex below catches the lowercase form
   anyway. */
const PERSON_NAME_RE = /\b[A-Z][a-z]+\b/g;
/* Wall-clock times like "9:42 AM" / "3:14:00 pm". Runs after lowercasing
   so the suffix matches in either case. */
const TIME_OF_DAY_RE =
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const DATE_WORDS_RE =
  /\b(?:yesterday|today|tomorrow|this morning|this afternoon|tonight|last night)\b/gi;
const WHITESPACE_RE = /\s+/g;

/**
 * Normalize a free-text input down to its conceptual signature. Two
 * tickets that describe the same conceptual issue — even with different
 * names, timestamps, and contact info — should normalize to the same
 * string and therefore collide on the sha256 below.
 *
 * Strips (in order):
 *   1. Email addresses
 *   2. UUIDs
 *   3. ISO 8601 timestamps
 *   4. Phone numbers
 *   5. Person names (capitalized standalone tokens not at start of input
 *      and not all-caps acronyms)
 * Then lowercases, then strips:
 *   6. Wall-clock times like "9:42 AM"
 *   7. Date-relative words like "yesterday" / "this morning"
 * Finally collapses whitespace.
 *
 * Why "Lorena got an MFA prompt at 9:42 AM yesterday" must normalize to
 * the same string as "Sarah got an MFA prompt at 3:14 PM today": same
 * conceptual ticket → same hash → cache hit.
 */
/* ReDoS guard: support tickets are bounded in length by the inbound
   email size limits already enforced upstream, but the regex engine
   should not burn time on adversarial input. PHONE_RE in particular
   has overlapping `[\s.-]?` separators that can backtrack on long
   digit-heavy strings. Cap to 16 KiB before any pattern runs. */
const MAX_SIGNATURE_INPUT_LEN = 16 * 1024;

export function normalizeForSignature(text: string): string {
  if (!text) return "";
  const bounded =
    text.length > MAX_SIGNATURE_INPUT_LEN
      ? text.slice(0, MAX_SIGNATURE_INPUT_LEN)
      : text;
  /* Pre-lowercase pass: case-sensitive patterns. */
  const preLower = bounded
    .replace(EMAIL_RE, " ")
    .replace(UUID_RE, " ")
    .replace(ISO_TIMESTAMP_RE, " ")
    .replace(PHONE_RE, " ")
    .replace(PERSON_NAME_RE, " ");
  /* Post-lowercase pass: case-insensitive patterns. */
  const stripped = preLower
    .toLowerCase()
    .replace(TIME_OF_DAY_RE, " ")
    .replace(DATE_WORDS_RE, " ");
  return stripped.replace(WHITESPACE_RE, " ").trim();
}

/**
 * Build the sha256 cache signature for a (feature, input) pair.
 *
 * Per-feature normalization:
 *   - support.draft     : title + body + diagnostic_text + sorted pattern_ids
 *   - support.categorize: title + body + diagnostic_text
 *   - support.auto_ack  : title + body + pattern_id
 *
 * Pattern ids are sorted for support.draft so the order the matcher
 * returned them in does not change the signature. The auto_ack key
 * intentionally uses just the single pattern_id the gate selected.
 */
export function signatureFor(
  feature: CacheFeature,
  input: CacheInput,
): string {
  const parts: string[] = [feature];
  if (input.feature === "support.draft") {
    parts.push(normalizeForSignature(input.title));
    parts.push(normalizeForSignature(input.body));
    parts.push(normalizeForSignature(input.diagnostic_text ?? ""));
    const sortedIds = [...input.pattern_ids].sort().join(",");
    parts.push(sortedIds);
  } else if (input.feature === "support.categorize") {
    parts.push(normalizeForSignature(input.title));
    parts.push(normalizeForSignature(input.body));
    parts.push(normalizeForSignature(input.diagnostic_text ?? ""));
  } else if (input.feature === "support.auto_ack") {
    parts.push(normalizeForSignature(input.title));
    parts.push(normalizeForSignature(input.body));
    parts.push(input.pattern_id);
  }
  return createHash("sha256").update(parts.join("␟")).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Row → AICompleteResponse                                            */
/* ------------------------------------------------------------------ */

/**
 * Coerce the JSONB cached_response back into an AICompleteResponse. We
 * always rewrite provider_used to "cache" so analytics + the call site
 * can attribute the savings without the original provider name leaking
 * through. The original provider/model stay on the cache row's
 * `provider_used` / `model_used` columns for analytics.
 */
function rowToResponse(row: Record<string, unknown>): AICompleteResponse {
  const cached = (row.cached_response as Record<string, unknown>) ?? {};
  return {
    content: typeof cached.content === "string" ? cached.content : "",
    model_used:
      typeof cached.model_used === "string"
        ? cached.model_used
        : String(row.model_used ?? "unknown"),
    /* Always re-stamp as 'cache' on a hit. Call sites + analytics see
       the cache attribution, not the original provider. */
    provider_used: "cache",
    input_tokens:
      typeof cached.input_tokens === "number" ? cached.input_tokens : 0,
    output_tokens:
      typeof cached.output_tokens === "number" ? cached.output_tokens : 0,
    cost_usd: 0,
    latency_ms: 0,
  };
}

/* ------------------------------------------------------------------ */
/* lookupCachedResponse                                                */
/* ------------------------------------------------------------------ */

/**
 * Look up a cached response by lexical signature. Returns
 * { hit: true, cached, cache_id } when a row exists AND its quality
 * gate passes (helpful_count >= unhelpful_count); otherwise
 * { hit: false }.
 *
 * Side effect on hit: increments hit_count + tokens_saved_estimate +
 * last_used_at so the eviction job can deprioritize cold rows. The
 * counter bump is best-effort — if it fails we still return the cached
 * response (the caller already has it in hand).
 *
 * Never throws. DB errors fall through to { hit: false } so the AI
 * feature calls the provider as if the cache did not exist.
 */
export async function lookupCachedResponse(
  args: LookupArgs,
): Promise<LookupResult> {
  if (!process.env.DATABASE_URL) {
    return { hit: false };
  }
  const sig = signatureFor(args.feature, args.input);
  let row: Record<string, unknown> | undefined;
  try {
    /* Quality gate: only serve rows where helpful >= unhelpful. A row
       that has been voted bad more often than good stops being served
       — the next request burns fresh tokens and writes a new row. */
    const r = await query<Record<string, unknown>>(
      `SELECT id, cached_response, model_used, provider_used,
              hit_count, helpful_count, unhelpful_count
         FROM instinct_support_response_cache
        WHERE feature = $1
          AND lexical_signature = $2
          AND helpful_count >= unhelpful_count
        LIMIT 1`,
      [args.feature, sig],
    );
    row = r.rows[0];
  } catch (err) {
    getObsClient().recordError(
      err instanceof Error ? err : new Error(String(err)),
      {
        feature: args.feature,
        stage: "cache_lookup",
      },
    );
    return { hit: false };
  }

  if (!row) {
    return { hit: false };
  }

  const cached = rowToResponse(row);
  const cacheId = String(row.id);
  /* Tokens-saved estimate uses the cached response's own input + output
     tokens. Each hit "saves" that many tokens since we bypass the
     provider call entirely. */
  const tokensSaved =
    (cached.input_tokens || 0) + (cached.output_tokens || 0);

  /* Best-effort hit counter bump. Wrapped in try/catch so a degraded DB
     cannot prevent us from returning the cached response. */
  try {
    await writeQuery(
      `UPDATE instinct_support_response_cache
          SET hit_count = hit_count + 1,
              tokens_saved_estimate = tokens_saved_estimate + $2,
              last_used_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [cacheId, tokensSaved],
    );
  } catch (err) {
    getObsClient().recordError(
      err instanceof Error ? err : new Error(String(err)),
      {
        feature: args.feature,
        stage: "cache_hit_bump",
        cache_id: cacheId,
      },
    );
    /* Counter bump failure is non-fatal — caller still gets the cached
       response. */
  }

  /* Fire the analytics event so the dashboard can show "we saved X
     tokens this week". Best-effort; trackEvent already swallows. */
  try {
    trackEvent("support.cache_hit", "system", "system", {
      feature: args.feature,
      cache_id: cacheId,
      tokens_saved: tokensSaved,
    });
  } catch {
    /* trackEvent is fire-and-forget; defensive double-catch. */
  }

  return { hit: true, cached, cache_id: cacheId };
}

/* ------------------------------------------------------------------ */
/* cacheResponse                                                       */
/* ------------------------------------------------------------------ */

/**
 * Persist a fresh AI response (cache miss path) OR bump an existing row
 * (cache hit path keeping the row warm).
 *
 * Behavior:
 *   - When `cache_id` is NOT provided: upserts (feature, lexical_signature)
 *     with the new response. ON CONFLICT bumps hit_count + last_used_at
 *     and refreshes the cached_response/model_used/provider_used so a
 *     re-generation under the same signature replaces stale content.
 *   - When `cache_id` IS provided: bumps hit_count + last_used_at on
 *     that row only (no INSERT, no overwrite). The caller is signalling
 *     "the cached row I just hit is still good — keep it warm".
 *
 * Returns the cache_id either way so the caller can stash it on the
 * ticket's cache_ids JSONB.
 *
 * Never throws. DB errors are logged via obs.recordError and the
 * function returns a synthetic cache_id of "" so the caller can detect
 * the failure but still proceed (the AI response is already in hand;
 * just future requests won't benefit from this cache row).
 */
export async function cacheResponse(
  args: CacheResponseArgs,
): Promise<CacheResponseResult> {
  if (!process.env.DATABASE_URL) {
    return { cache_id: "" };
  }
  const sig = signatureFor(args.feature, args.input);

  if (args.cache_id) {
    /* Warm-only path: keep the existing row hot without rewriting it. */
    try {
      await writeQuery(
        `UPDATE instinct_support_response_cache
            SET hit_count = hit_count + 1,
                last_used_at = NOW()
          WHERE id = $1
          RETURNING id`,
        [args.cache_id],
      );
    } catch (err) {
      getObsClient().recordError(
        err instanceof Error ? err : new Error(String(err)),
        {
          feature: args.feature,
          stage: "cache_warm",
          cache_id: args.cache_id,
        },
      );
    }
    return { cache_id: args.cache_id };
  }

  /* Upsert path. ON CONFLICT (feature, lexical_signature) bumps the
     existing row rather than failing — covers the case where two
     concurrent requests miss the cache and both try to insert. */
  try {
    const r = await writeQuery<{ id: string }>(
      `INSERT INTO instinct_support_response_cache
         (feature, lexical_signature, prompt_input, cached_response,
          model_used, provider_used, hit_count, helpful_count,
          unhelpful_count, last_used_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 0, 0, 0, NOW())
       ON CONFLICT (feature, lexical_signature) DO UPDATE
         SET cached_response = EXCLUDED.cached_response,
             model_used = EXCLUDED.model_used,
             provider_used = EXCLUDED.provider_used,
             last_used_at = NOW()
       RETURNING id`,
      [
        args.feature,
        sig,
        JSON.stringify(args.input),
        JSON.stringify({
          content: args.response.content,
          model_used: args.response.model_used,
          provider_used: args.response.provider_used,
          input_tokens: args.response.input_tokens,
          output_tokens: args.response.output_tokens,
          /* cost_usd + latency_ms are NOT cached — every hit reports
             zero for both since we did not actually call the provider. */
        }),
        args.response.model_used,
        args.response.provider_used,
      ],
      { expectRows: 1 },
    );
    return { cache_id: r.rows[0].id };
  } catch (err) {
    getObsClient().recordError(
      err instanceof Error ? err : new Error(String(err)),
      {
        feature: args.feature,
        stage: "cache_write",
      },
    );
    return { cache_id: "" };
  }
}

/* ------------------------------------------------------------------ */
/* recordCacheFeedback                                                 */
/* ------------------------------------------------------------------ */

/**
 * Bump the helpful_count or unhelpful_count counter on a cache row. The
 * lookup helper refuses to serve rows whose unhelpful balance exceeds
 * helpful, so this is the channel that lets a bad cached response stop
 * poisoning future requests once the operator votes.
 *
 * Never throws. DB errors are logged via obs.recordError. The feedback
 * handler treats this as best-effort — the operator's primary feedback
 * (on the ticket itself) lands regardless.
 */
export async function recordCacheFeedback(
  cache_id: string,
  helpful: boolean,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  if (!cache_id) return;
  const column = helpful ? "helpful_count" : "unhelpful_count";
  try {
    await writeQuery(
      `UPDATE instinct_support_response_cache
          SET ${column} = ${column} + 1
        WHERE id = $1
        RETURNING id`,
      [cache_id],
    );
  } catch (err) {
    getObsClient().recordError(
      err instanceof Error ? err : new Error(String(err)),
      {
        stage: "cache_feedback",
        cache_id,
        helpful,
      },
    );
  }
}
