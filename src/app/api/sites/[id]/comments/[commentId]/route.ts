/**
 * DELETE /api/sites/[id]/comments/[commentId]
 *
 * Path C Phase 3 · Stream R3. SOFT delete — marks the body as
 * "[deleted]" but preserves the row so the audit trail + analytics
 * signal (how often designers reconsider and delete) stay intact.
 *
 * Auth: role ≥ sales (same floor as the parent comments route).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { deleteComment, getComment } from "@/lib/section-comments";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id, commentId } = await context.params;

  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const site = await getSiteProject(id);
  if (!site) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!hasRole(user.role, "sales")) {
    return NextResponse.json(
      { error: "insufficient role", reason: "role_insufficient" },
      { status: 403 },
    );
  }

  const existing = await getComment(commentId);
  if (!existing) {
    return NextResponse.json(
      { error: "comment not found", reason: "comment_missing" },
      { status: 404 },
    );
  }
  if (existing.siteId !== id) {
    return NextResponse.json(
      { error: "comment does not belong to this site", reason: "site_mismatch" },
      { status: 404 },
    );
  }

  try {
    await deleteComment({ commentId, userId: user.id });
    trackEvent("site.comment_deleted", user.id, user.role, {
      site_id: id,
      comment_id: commentId,
      deleted_by_role: user.role,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof WriteQueryError) {
      return NextResponse.json(
        { error: "Failed to delete comment", reason: err.code },
        { status: 503 },
      );
    }
    console.error("[sites/comments/DELETE]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
