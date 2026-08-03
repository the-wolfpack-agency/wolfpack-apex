/**
 * POST /api/people/roster/[id]/access   Body: { active: boolean }
 *
 * Take a member's access away, or give it back. `id` is an
 * instinct_team_members id.
 *
 * There was no way to do either before this. `is_active` was read on every
 * authenticated path and written by nothing, so a teammate who left kept
 * working credentials indefinitely and a person removed by mistake could not be
 * restored.
 *
 * Revoking sets is_active = false, which is already the condition every auth
 * path checks: /api/auth/refresh, /api/auth/whoami, change-password,
 * forgot-password and the Microsoft callback all require is_active = TRUE. So a
 * revoked member cannot refresh, cannot re-authenticate, and cannot reset their
 * way back in. Their current access token still works until it expires, which
 * is at most 15 minutes.
 *
 * Restoring is a plain reactivation. It deliberately does NOT touch the
 * password: somebody restored still has whatever credential they had, and if
 * they have none they go through the ordinary invite or reset path.
 *
 * Requires `settings.manage_team`: CTO and CEO, not HR. HR can see the roster
 * and manage employee records; changing who can sign in is a separate authority.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery, query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id: targetId } = await params;
  const body = (await req.json().catch(() => null)) as { active?: unknown } | null;
  if (!body || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active must be true or false" }, { status: 400 });
  }
  const nextActive = body.active;

  /* Removing your own access locks you out of the surface you would need to
     undo it, and if you are the last administrator it locks everyone out. */
  if (targetId === auth.user.id && !nextActive) {
    return NextResponse.json(
      { error: "You cannot remove your own access. Ask another administrator." },
      { status: 400 },
    );
  }

  const { rows, fromCache } = await safeQuery<{
    email: string;
    name: string;
    role: string;
    is_active: boolean;
  }>(
    `SELECT email, name, role, is_active
       FROM instinct_team_members
      WHERE id = $1 AND workspace_id = $2`,
    [targetId, auth.user.workspaceId],
  );
  if (fromCache && process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Database temporarily unavailable." }, { status: 503 });
  }
  /* Scoped by workspace, so this is also the answer for a member of another
     tenant: not found, rather than a hint that the id exists somewhere. */
  if (rows.length === 0) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }
  const before = rows[0];

  if (before.is_active === nextActive) {
    return NextResponse.json({ ok: true, id: targetId, active: nextActive, unchanged: true });
  }

  const result = await query(
    `UPDATE instinct_team_members
        SET is_active = $2
      WHERE id = $1 AND workspace_id = $3`,
    [targetId, nextActive, auth.user.workspaceId],
  );
  if ((result.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  trackEvent(
    nextActive ? "team.access_restored" : "team.access_revoked",
    auth.user.id,
    auth.user.role,
    { member_id: targetId, member_role: before.role, changed_by: auth.user.id },
  );

  /* Granting and removing the ability to sign in is precisely what the
     hash-chained log is for. Best-effort, mirroring the role route: the access
     change has already committed and must not be reported as failed because
     bookkeeping did. */
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: nextActive ? "admin.user.access_restored" : "admin.user.access_revoked",
    resourceType: "team_member",
    resourceId: targetId,
    beforeState: { is_active: before.is_active },
    afterState: { is_active: nextActive },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, id: targetId, active: nextActive });
}
