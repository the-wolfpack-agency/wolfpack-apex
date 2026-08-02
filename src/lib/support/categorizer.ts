/**
 * support / categorizer — AI auto-classifier for support tickets.
 *
 * Classifies an incoming ticket title + body + (optional) diagnostic text
 * into one of a fixed set of operator-facing categories. Used by the
 * POST /api/support/tickets manual-create flow AND the email inbox
 * poller so every ticket lands with the right category whether it was
 * filed by an operator or by a customer email.
 *
 * Implementation:
 *   - Uses the provider-neutral AI abstraction (`getAIClient().complete`)
 *     so the cheap-tier router decision (Haiku today) stays a routing
 *     concern, not a feature concern. Cost per call is ~fractions of a
 *     cent.
 *   - Asks the model for a JSON object: { category, confidence,
 *     reasoning }. We parse defensively. Anything that fails parse,
 *     missing-category, low-confidence (<0.6), unknown-category, or AI
 *     throw → falls back to category 'general' with confidence 0. The
 *     caller never has to handle a thrown error from this helper.
 *   - sensitivity='public' (ticket bodies are operator data, not PHI),
 *     metadata.feature='support.categorize' so analytics can split this
 *     specific call out of the broader ai.completion firehose.
 */

import { getAIClient } from "@/lib/ai";
import type { AIMessage } from "@/lib/ai";
import {
  cacheResponse,
  lookupCachedResponse,
} from "@/lib/ai/response-cache";
import { renderPrompt } from "@/lib/prompts/registry";
import { SUPPORT_CATEGORIZE } from "@/lib/prompts/definitions/support";

export type SupportCategory =
  | "m365"
  | "azure"
  | "instinct"
  | "wolfpack-auto"
  | "porsche-classes"
  | "billing"
  | "urgent"
  | "general";

export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  "m365",
  "azure",
  "instinct",
  "wolfpack-auto",
  "porsche-classes",
  "billing",
  "urgent",
  "general",
] as const;

export interface CategorizeInput {
  title: string;
  body: string;
  diagnostic_text?: string;
}

export interface CategorizeResult {
  category: SupportCategory;
  confidence: number;
  reasoning?: string;
  /**
   * Cache row id this classification was either served from (cache hit)
   * or saved into (cache miss). Stored on the ticket's cache_ids JSONB
   * so the feedback handler can propagate operator votes. Null when
   * persistence failed or the row could not be written.
   */
  cache_id?: string | null;
  /** Provider attribution. 'cache' on a hit, otherwise the upstream
   *  provider name. Falls back to undefined on the FALLBACK path so
   *  call sites can ignore it. */
  provider_used?: string;
}

/**
 * Confidence floor below which we coerce the result to 'general'. Set
 * intentionally a touch higher than the Anthropic model's "I'm guessing"
 * range so the operator sees a real signal when the AI was sure.
 */
const CONFIDENCE_FLOOR = 0.6;

 
/* Prompt lives in the registry: src/lib/prompts/definitions/support.ts.
   It has an id an eval can score and a version a regression can be bisected
   against, neither of which a string constant here can offer. */
const SYSTEM_PROMPT: string = renderPrompt(SUPPORT_CATEGORIZE, {});
 

/**
 * Build the user message payload from a ticket. Title and body are
 * concatenated with a small label so the model can distinguish subject
 * from body. Diagnostic text is appended only when present so we don't
 * waste tokens on an empty section.
 */
function buildUserMessage(input: CategorizeInput): string {
  const lines: string[] = [];
  lines.push(`Subject: ${input.title}`);
  lines.push(`Body:\n${input.body}`);
  if (input.diagnostic_text && input.diagnostic_text.trim().length > 0) {
    lines.push(`Diagnostic:\n${input.diagnostic_text}`);
  }
  lines.push(
    "\nReturn the JSON object now. Do not include any other text.",
  );
  return lines.join("\n\n");
}

/**
 * Defensive JSON parser. The model occasionally wraps its output in a
 * markdown fence or prepends a sentence. We strip the most common
 * envelope variations before JSON.parse so a single stray newline does
 * not cost us a categorization.
 */
function tryParseJSON(text: string): unknown {
  if (!text) return null;
  const trimmed = text.trim();
  /* Strip a leading/trailing ``` fence (``` or ```json). */
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  /* Pull out the first {...} block — handles "Here is the JSON: { ... }". */
  const braceStart = fenced.indexOf("{");
  const braceEnd = fenced.lastIndexOf("}");
  const candidate =
    braceStart >= 0 && braceEnd > braceStart
      ? fenced.slice(braceStart, braceEnd + 1)
      : fenced;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function isSupportCategory(v: unknown): v is SupportCategory {
  return (
    typeof v === "string" &&
    (SUPPORT_CATEGORIES as readonly string[]).includes(v)
  );
}

function clampConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

const FALLBACK: CategorizeResult = {
  category: "general",
  confidence: 0,
  reasoning: "categorizer fallback",
};

/**
 * Auto-classify a support ticket. Never throws — every error path
 * returns the 'general' fallback so call sites do not have to wrap this
 * in try/catch a second time. Callers are still encouraged to use a
 * try/catch for belt-and-braces safety because the wider transaction
 * around them (createTicket → setTicketCategory) shouldn't fail when
 * the AI provider is degraded.
 */
export async function categorizeTicket(
  input: CategorizeInput,
): Promise<CategorizeResult> {
  /* Persistent cache lookup. Categorization is deterministic given the
     same input; a previously-classified ticket should never burn fresh
     tokens. Cache failures fall through to a miss — the AI call is
     never blocked by a degraded cache. */
  let cacheHitId: string | null = null;
  try {
    const lookup = await lookupCachedResponse({
      feature: "support.categorize",
      input: {
        feature: "support.categorize",
        title: input.title,
        body: input.body,
        diagnostic_text: input.diagnostic_text ?? null,
      },
    });
    if (lookup.hit) {
      const parsedHit = tryParseJSON(lookup.cached.content);
      if (parsedHit && typeof parsedHit === "object") {
        const obj = parsedHit as Record<string, unknown>;
        if (isSupportCategory(obj.category)) {
          const conf = clampConfidence(obj.confidence);
          const reasoning =
            typeof obj.reasoning === "string" && obj.reasoning.length > 0
              ? obj.reasoning.slice(0, 280)
              : undefined;
          /* Apply the same low-confidence guard the fresh path applies
             so the cached low-confidence response is treated identically
             to a fresh low-confidence response. */
          if (conf < CONFIDENCE_FLOOR) {
            return {
              category: "general",
              confidence: conf,
              reasoning:
                reasoning ??
                `low confidence (${conf.toFixed(2)} < ${CONFIDENCE_FLOOR})`,
              cache_id: lookup.cache_id,
              provider_used: "cache",
            };
          }
          return {
            category: obj.category,
            confidence: conf,
            reasoning,
            cache_id: lookup.cache_id,
            provider_used: "cache",
          };
        }
      }
      /* Hit but the cached content failed to parse cleanly. Treat as a
         miss + fall through; we'll write a fresh row. Stash the id so
         the writer can update-in-place rather than insert a duplicate. */
      cacheHitId = lookup.cache_id;
    }
  } catch {
    /* lookup helper already logs; defensive double-swallow. */
  }

  const userMessage = buildUserMessage(input);
  const messages: AIMessage[] = [{ role: "user", content: userMessage }];

  let response;
  try {
    response = await getAIClient().complete({
      messages,
      system: SYSTEM_PROMPT,
      max_tokens: 200,
      /* Low temperature: classification, not creative writing. We
         want stable + reproducible outputs. */
      temperature: 0,
      model_tier: "cheap",
      sensitivity: "public",
      metadata: { feature: "support.categorize" },
    });
  } catch (err) {
    console.warn(
      "[support/categorizer] AI complete threw:",
      (err as Error).message,
    );
    return { ...FALLBACK };
  }

  /* Cache the fresh response for future requests. Failure here is
     non-fatal — the categorization still returns. */
  let cacheId: string | null = cacheHitId;
  try {
    const written = await cacheResponse({
      feature: "support.categorize",
      input: {
        feature: "support.categorize",
        title: input.title,
        body: input.body,
        diagnostic_text: input.diagnostic_text ?? null,
      },
      response,
    });
    cacheId = written.cache_id || cacheHitId;
  } catch {
    /* swallowed; defensive double-catch. */
  }

  const parsed = tryParseJSON(response.content);
  if (!parsed || typeof parsed !== "object") {
    return { ...FALLBACK, reasoning: "categorizer parse failure" };
  }
  const obj = parsed as Record<string, unknown>;
  const cat = isSupportCategory(obj.category) ? obj.category : null;
  const confidence = clampConfidence(obj.confidence);
  const reasoning =
    typeof obj.reasoning === "string" && obj.reasoning.length > 0
      ? obj.reasoning.slice(0, 280)
      : undefined;

  if (!cat) {
    return { ...FALLBACK, reasoning: "unknown category from model" };
  }
  /* Low-confidence guard: even when the model picked a specific
     category, treat it as 'general' so we never mislabel a ticket on a
     wobbly signal. The reasoning is preserved so the operator + the
     learning loop can see what the model was leaning toward. */
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      category: "general",
      confidence,
      reasoning:
        reasoning ??
        `low confidence (${confidence.toFixed(2)} < ${CONFIDENCE_FLOOR})`,
      cache_id: cacheId,
      provider_used: response.provider_used,
    };
  }

  return {
    category: cat,
    confidence,
    reasoning,
    cache_id: cacheId,
    provider_used: response.provider_used,
  };
}
