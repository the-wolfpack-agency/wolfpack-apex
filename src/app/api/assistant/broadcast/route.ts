/**
 * POST /api/assistant/broadcast
 *
 * One message, written into every team member's assistant.
 *
 * GATED ON settings.manage_team, deliberately, rather than on a new
 * capability. Writing into everybody's assistant is an action on the team, and
 * that is the capability which already governs acting on the team. A new
 * capability would need a migration, a role map entry and a consent story, all
 * to express a permission the existing one already expresses.
 *
 * ONE-WAY. There is no reply endpoint, because the chat has no thread model
 * for a reply to land in and an unwatched reply is worse than none. The
 * message carries the existing feedback compose form instead, so a response
 * goes to the queue somebody already reads.
 *
 * Responses:
 *   200 { delivered, failed, redacted }  sent, possibly to a subset
 *   207 { ... }                          some recipients could not be written
 *   400 invalid_input                    empty or over-length message
 *   401 / 403                            via requireCapability
 *   503 recipients_unreadable            the list could not be read, so
 *                                        nothing was sent and nothing is
 *                                        claimed
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  broadcastToAssistants,
  listRecipients,
  MAX_BROADCAST_CHARS,
} from "@/lib/assistant/broadcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: how many people a broadcast would reach.
 *
 * Read from the same query the send uses, so the number in "send to 42 people"
 * describes the set that will actually receive it. A count from a different
 * source is a confirmation about a different group.
 *
 * Returns readable:false rather than 0 when the list cannot be read, because
 * the compose surface must not offer to send to nobody as though that were a
 * real answer.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const listed = await listRecipients(auth.user.workspaceId);
  return NextResponse.json(
    { recipients: listed.recipients.length, readable: listed.readable },
    { status: listed.readable ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: { message?: unknown; action_url?: unknown; action_label?: unknown; allow_feedback?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "body must be JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json(
      { error: "invalid_input", detail: "message is required" },
      { status: 400 },
    );
  }
  if (message.length > MAX_BROADCAST_CHARS) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: `message may be at most ${MAX_BROADCAST_CHARS} characters`,
      },
      { status: 400 },
    );
  }

  const result = await broadcastToAssistants({
    message,
    workspaceId: user.workspaceId,
    actorId: user.id,
    actorRole: user.role,
    ...(typeof body.action_url === "string" ? { actionUrl: body.action_url } : {}),
    ...(typeof body.action_label === "string" ? { actionLabel: body.action_label } : {}),
    ...(body.allow_feedback === false ? { allowFeedback: false } : {}),
  });

  /* AN UNREADABLE RECIPIENT LIST IS NOT AN EMPTY ONE. Returning 200 with
     delivered: 0 would tell the sender the company was messaged when nobody
     was, which is the worst possible outcome for an announcement. */
  if (!result.readable) {
    return NextResponse.json(
      {
        error: "recipients_unreadable",
        detail: "the recipient list could not be read, so nothing was sent",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      delivered: result.delivered,
      failed: result.failed,
      redacted: result.redacted,
    },
    { status: result.failed > 0 ? 207 : 200 },
  );
}
