/**
 * POST /api/assistant/draft-reply
 *
 * Server-side AI draft generator. Consumers in the UI (chat composer,
 * channel composer, email composer) hand us thread context + an
 * optional draft-so-far; we return a suggested reply text. The
 * suggestion is purely a starting point — the user is expected to
 * edit before sending.
 *
 * Request body:
 *   {
 *     surface: "chat" | "channel" | "email",
 *     recipientName?: string,
 *     threadContext?: { from: string, text: string }[],
 *     draftSoFar?: string,
 *     tone?: string,
 *     contextId?: string,   // chat_id, channel_id, message_id — for analytics
 *   }
 *
 * Response:
 *   200 { text, model, promptTokens, completionTokens }
 *   401 { error: "Unauthorized" }
 *   400 { error: "..." }    — missing surface
 *   500 { error: "Internal error" }
 *
 * Analytics: every call fires assistant.draft_requested with surface
 * + token usage so the warehouse sees AI cost per surface and per
 * user. Acceptance/rejection is tracked client-side via
 * assistant.draft_accepted / assistant.draft_modified — see
 * src/lib/analytics.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getDraftProvider,
  type DraftSurface,
  type DraftRequestContext,
} from "@/lib/ai/draft-provider";

const VALID_SURFACES: DraftSurface[] = ["chat", "channel", "email"];

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Partial<DraftRequestContext> & { contextId?: string };
  try {
    body = (await req.json()) as Partial<DraftRequestContext> & {
      contextId?: string;
    };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.surface || !VALID_SURFACES.includes(body.surface as DraftSurface)) {
    return NextResponse.json(
      { error: "surface must be one of chat | channel | email" },
      { status: 400 },
    );
  }
  // Hard cap thread context size to keep prompts bounded + costs predictable.
  const threadContext = Array.isArray(body.threadContext)
    ? body.threadContext.slice(-30).filter(
        (t): t is { from: string; text: string } =>
          typeof t?.from === "string" && typeof t?.text === "string",
      )
    : undefined;
  const draftSoFar =
    typeof body.draftSoFar === "string" ? body.draftSoFar.slice(0, 4000) : undefined;
  try {
    const provider = getDraftProvider();
    const result = await provider.draftReply({
      surface: body.surface as DraftSurface,
      recipientName:
        typeof body.recipientName === "string"
          ? body.recipientName.slice(0, 120)
          : undefined,
      threadContext,
      draftSoFar,
      tone: typeof body.tone === "string" ? body.tone.slice(0, 40) : undefined,
      selfName: user.name ?? undefined,
    });
    trackEvent("assistant.draft_requested", user.id, user.role, {
      surface: body.surface as string,
      context_id: body.contextId ?? "",
      had_draft_so_far: !!draftSoFar,
      thread_turns: threadContext?.length ?? 0,
      model: result.model,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
    });
    return NextResponse.json({
      text: result.text,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
  } catch (err) {
    console.error("[api/assistant/draft-reply] error:", (err as Error).message);
    trackEvent("assistant.draft_failed", user.id, user.role, {
      surface: body.surface as string,
      reason: (err as Error).message.slice(0, 120),
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
