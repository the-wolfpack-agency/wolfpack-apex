/**
 * POST /api/support/tickets/[id]/feedback — operator marks the response as
 * helpful / unhelpful and optionally captures an edit_diff for learning.
 *
 * Body: { helpful: boolean, edit_diff?: object, notes?: string }
 *
 * Auth: `automations.run` capability.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordFeedback } from "@/lib/support/repo";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.helpful !== "boolean") {
    return NextResponse.json(
      { error: "helpful_required" },
      { status: 400 },
    );
  }
  const helpful = b.helpful;
  const editDiff =
    b.edit_diff && typeof b.edit_diff === "object"
      ? (b.edit_diff as Record<string, unknown>)
      : null;
  const notes = typeof b.notes === "string" ? b.notes : null;

  try {
    const { id } = await ctx.params;
    const ticket = await recordFeedback(id, {
      helpful,
      edit_diff: editDiff,
      notes,
      reviewed_by_user_id: auth.user.id,
    });
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    trackEvent("support.feedback_submitted", auth.user.id, auth.user.role, {
      ticket_id: id,
      helpful,
      has_edit_diff: editDiff !== null,
    });

    return NextResponse.json({ ticket });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
