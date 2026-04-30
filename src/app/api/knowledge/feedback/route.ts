/**
 * POST /api/knowledge/feedback
 *
 * Increments helpful_count or not_helpful_count on a knowledge_qa_entries
 * row. Powers the 👍/👎 buttons under every Q&A answer card on
 * /knowledge and /assistant.
 *
 * Request body:
 *   {
 *     qa_id: string,
 *     helpful: boolean,
 *     fell_back_to_ticket?: boolean   // only meaningful for assistant_support
 *   }
 *
 * Response (200): { ok: true }
 * Errors: 401 / 400 / 500.
 *
 * Analytics:
 *   knowledge.qa_feedback             { qa_id, helpful, surface? }
 *   assistant.support_query (update)  emitted when fell_back_to_ticket=true
 *     so the learning loop can grade self-serve success rate.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordFeedback } from "@/lib/knowledge/qa-cache";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "knowledge.search");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  let body: {
    qa_id?: unknown;
    helpful?: unknown;
    surface?: unknown;
    fell_back_to_ticket?: unknown;
  };
  try {
    body = (await req.json()) as {
      qa_id?: unknown;
      helpful?: unknown;
      surface?: unknown;
      fell_back_to_ticket?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const qaId = typeof body.qa_id === "string" ? body.qa_id.trim() : "";
  if (!qaId) {
    return NextResponse.json(
      { error: "qa_id is required" },
      { status: 400 },
    );
  }
  if (typeof body.helpful !== "boolean") {
    return NextResponse.json(
      { error: "helpful must be a boolean" },
      { status: 400 },
    );
  }
  const surface = typeof body.surface === "string" ? body.surface : "knowledge";

  try {
    await recordFeedback(qaId, body.helpful);
    trackEvent("knowledge.qa_feedback", user.id, user.role, {
      qa_id: qaId,
      helpful: body.helpful,
      surface,
    });
    if (
      surface === "assistant_support" &&
      body.fell_back_to_ticket === true
    ) {
      trackEvent("assistant.support_query", user.id, user.role, {
        qa_id: qaId,
        was_cache_hit: false,
        fell_back_to_ticket: true,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/knowledge/feedback] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
