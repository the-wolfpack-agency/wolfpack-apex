/**
 * PATCH /api/sites/[id]/brief-edit/[editId] — record the user's decision
 * on a proposed brief edit.
 *
 * Body: { accepted: boolean, rejectionReason?: string }
 *
 * Flips the audit row in apex_site_brief_edits from accepted=NULL to
 * accepted=true|false and stamps decided_at. Emits site.brief_edit_decided
 * so the brain learns which prompts converted to real saves vs. were
 * discarded — this is the learning signal for the editor quality over time.
 *
 * Does NOT apply the patch to the saved brief. The UI calls the existing
 * PATCH /api/sites/[id] (with the renderedBrief as body) to persist. That
 * keeps save/deploy flow identical to form-based edits.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { recordBriefEditDecision } from "@/lib/brief-edit";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; editId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(user.role, "sales")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { editId } = await context.params;

  let body: { accepted?: unknown; rejectionReason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.accepted !== "boolean") {
    return NextResponse.json(
      { error: "accepted (boolean) required" },
      { status: 400 },
    );
  }

  const rejectionReason =
    typeof body.rejectionReason === "string" ? body.rejectionReason : undefined;

  try {
    await recordBriefEditDecision(
      editId,
      body.accepted,
      user.id,
      user.role,
      rejectionReason,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[sites/id/brief-edit/editId]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
