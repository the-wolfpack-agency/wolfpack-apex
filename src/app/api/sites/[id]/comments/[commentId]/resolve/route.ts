/**
 * POST /api/sites/[id]/comments/[commentId]/resolve
 *
 * Path C Phase 3 · Stream R3. Authed designer marks a comment (and
 * every descendant reply) resolved. Idempotent — re-resolving already-
 * resolved rows returns 200 with the current record.
 *
 * Auth: role ≥ sales (same floor as the parent comments route).
 *
 * Analytics: site.comment_resolved fires with resolved_by_role so the
 * learning loop can track resolve velocity per role — a high resolve
 * rate from sales staff vs. devs is a signal about who owns the
 * client-feedback loop.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { resolveComment, getComment } from "@/lib/section-comments";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";

export async function POST(
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

  // Pre-check: the comment must exist AND belong to this site. Prevents
  // a caller from resolving a comment on site B by URL-rewriting the
  // site segment. The shape is cheap — single-row SELECT off the PK.
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
    const record = await resolveComment({ commentId, userId: user.id });
    trackEvent("site.comment_resolved", user.id, user.role, {
      site_id: id,
      comment_id: commentId,
      resolved_by_role: user.role,
    });
    return NextResponse.json({ comment: record });
  } catch (err) {
    if (err instanceof WriteQueryError) {
      return NextResponse.json(
        { error: "Failed to resolve comment", reason: err.code },
        { status: 503 },
      );
    }
    console.error("[sites/comments/resolve]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
