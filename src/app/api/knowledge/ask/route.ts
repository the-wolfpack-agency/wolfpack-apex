/**
 * POST /api/knowledge/ask
 *
 * Semantic Q&A cache with LLM fallback. Powers /knowledge ("Ask a
 * Question") and /assistant (Support mode).
 *
 * Request body:
 *   {
 *     question: string,
 *     surface: "knowledge" | "assistant_support"
 *   }
 *
 * Response (200):
 *   {
 *     qa_id: string,
 *     answer: string,
 *     source: "ai_generated" | "internal_doc" | "human_curated",
 *     ai_model?: string | null,
 *     ai_generated_at?: string | null,
 *     was_cache_hit: boolean,
 *     similarity?: number,
 *     latency_ms: number,
 *   }
 *
 * Errors:
 *   401 — caller not authenticated (delegated to requireCapability).
 *   400 — question missing/empty or surface invalid.
 *   500 — unexpected server error.
 *
 * Analytics (always, fire-and-forget):
 *   knowledge.qa_lookup           { surface, was_cache_hit, similarity?,
 *                                   latency_ms } — every request.
 *   knowledge.qa_ai_generated     { surface, ai_model, prompt_tokens?,
 *                                   completion_tokens?, latency_ms } —
 *                                   only on miss (i.e. fresh LLM call).
 *   assistant.support_query       { qa_id, was_cache_hit,
 *                                   fell_back_to_ticket } — only when
 *                                   surface === 'assistant_support'.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { askWithCache, type QASurface } from "@/lib/knowledge/qa-cache";

const VALID_SURFACES: QASurface[] = ["knowledge", "assistant_support"];

/**
 * Tiny heuristic: an answer is "low confidence" when the model says so
 * explicitly or returns something so short it cannot possibly be useful.
 * The /assistant UI uses this to surface the "Submit a support ticket"
 * CTA. Centralized here so the API and UI agree on the rule.
 */
function isLowConfidenceAnswer(answer: string): boolean {
  if (!answer) return true;
  if (answer.trim().length < 40) return true;
  const lower = answer.toLowerCase();
  return (
    lower.includes("i don't know") ||
    lower.includes("i do not know") ||
    lower.includes("i'm not sure") ||
    lower.includes("i am not sure") ||
    lower.includes("submit a support ticket") ||
    lower.includes("contact support")
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "knowledge.search");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  let body: { question?: unknown; surface?: unknown };
  try {
    body = (await req.json()) as { question?: unknown; surface?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const question =
    typeof body.question === "string" ? body.question.trim() : "";
  const surface =
    typeof body.surface === "string" ? body.surface : "knowledge";

  if (!question) {
    return NextResponse.json(
      { error: "question is required" },
      { status: 400 },
    );
  }
  if (!VALID_SURFACES.includes(surface as QASurface)) {
    return NextResponse.json(
      { error: "surface must be 'knowledge' or 'assistant_support'" },
      { status: 400 },
    );
  }

  try {
    const result = await askWithCache({
      question,
      surface: surface as QASurface,
      userId: user.id,
    });

    /* Always-on lookup telemetry — feeds the cache-hit-rate metric. */
    trackEvent("knowledge.qa_lookup", user.id, user.role, {
      surface,
      was_cache_hit: result.was_cache_hit,
      similarity: result.similarity ?? 0,
      latency_ms: result.latency_ms,
    });

    /* Token-cost telemetry only fires on a miss, where we actually paid. */
    if (!result.was_cache_hit && result.source === "ai_generated") {
      trackEvent("knowledge.qa_ai_generated", user.id, user.role, {
        surface,
        ai_model: result.ai_model ?? "unknown",
        prompt_tokens: result.prompt_tokens ?? 0,
        completion_tokens: result.completion_tokens ?? 0,
        latency_ms: result.latency_ms,
      });
    }

    /* Support-mode learning loop — was this a successful self-serve, or
       did the user end up needing a ticket? The UI later updates this
       row when the user clicks the ticket CTA; the API surfaces the
       initial signal here. */
    if (surface === "assistant_support") {
      trackEvent("assistant.support_query", user.id, user.role, {
        qa_id: result.qa_id,
        was_cache_hit: result.was_cache_hit,
        fell_back_to_ticket: false,
        low_confidence: isLowConfidenceAnswer(result.answer),
      });
    }

    return NextResponse.json({
      qa_id: result.qa_id,
      answer: result.answer,
      source: result.source,
      ai_model: result.ai_model,
      ai_generated_at: result.ai_generated_at,
      was_cache_hit: result.was_cache_hit,
      similarity: result.similarity,
      latency_ms: result.latency_ms,
      low_confidence: isLowConfidenceAnswer(result.answer),
    });
  } catch (err) {
    const message = (err as Error).message ?? "";
    console.error("[api/knowledge/ask] error:", message);
    if (
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|api[\s_-]?key.*(?:not configured|missing)/i.test(
        message,
      )
    ) {
      return NextResponse.json(
        { error: "AI assistant not configured", code: "missing_api_key" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
