/**
 * POST /api/admin/users/[id]/role
 *
 * Body: { role: TeamRole }
 *
 * Requires: `admin.roles.assign`. Emits `system.role_changed`.
 * The existing instinct_team_members.role column is the source of truth —
 * no new schema.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { isTeamRole } from "@/lib/auth/role-capabilities";
import { safeQuery, query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "admin.roles.assign");
  if (!auth.ok) return auth.response;

  const { id: targetUserId } = await params;
  const body = (await req.json().catch(() => null)) as { role?: unknown } | null;
  if (!body || !isTeamRole(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  /* NOBODY CHANGES THEIR OWN ROLE, in either direction.
   *
   * Downward it is a locked door: the only people who can assign roles are the
   * ones who would be removing that ability from themselves, and restoring it
   * then needs a database session rather than the product.
   *
   * Upward it removes the second person from a privilege escalation. Whoever
   * can assign roles can already assign themselves anything, so the control is
   * not about capability; it is about there being a record that says one
   * person granted authority to another. A self-change makes that record say
   * nothing.
   *
   * Both are the same fix, so it is one rule rather than two. */
  if (targetUserId === auth.user.id) {
    return NextResponse.json(
      {
        error: "cannot_change_own_role",
        message:
          "You cannot change your own role. Ask another admin, so the change is one person granting authority to another rather than to themselves.",
      },
      { status: 403 },
    );
  }

  // Shadow mode: no DB, still allow analytics + echo back.
  if (!process.env.DATABASE_URL) {
    trackEvent("system.role_changed", auth.user.id, auth.user.role, {
      user_id: targetUserId,
      from_role: "unknown",
      to_role: body.role,
      changed_by: auth.user.id,
    });
    return NextResponse.json({ ok: true, role: body.role, shadow: true });
  }

  // Look up existing role for the audit event
  const { rows } = await safeQuery<{ role: string }>(
    `SELECT role FROM instinct_team_members WHERE id = $1 AND is_active = true`,
    [targetUserId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  const fromRole = rows[0].role;

  const result = await query(
    `UPDATE instinct_team_members SET role = $2 WHERE id = $1 AND is_active = true`,
    [targetUserId, body.role],
  );
  if ((result.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  trackEvent("system.role_changed", auth.user.id, auth.user.role, {
    user_id: targetUserId,
    from_role: fromRole,
    to_role: body.role,
    changed_by: auth.user.id,
  });

  // A role change is exactly what the hash-chained audit log exists for: who
  // granted what authority to whom, before/after, when. Best-effort write that
  // never breaks the response (mirrors the /name route).
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "admin.user.role_changed",
    resourceType: "team_member",
    resourceId: targetUserId,
    beforeState: { role: fromRole },
    afterState: { role: body.role },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, from_role: fromRole, to_role: body.role });
}
