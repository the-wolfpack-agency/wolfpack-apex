/**
 * /api/team/accept — accept a team invite and set a password.
 *
 * Public endpoint (no auth required — the user is accepting an invite).
 */

import { NextRequest, NextResponse } from "next/server";
import { safeQuery } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { randomUUID } from "crypto";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || !body.token || !body.password) {
    return NextResponse.json({ error: "token and password required" }, { status: 400 });
  }

  if (typeof body.password !== "string" || body.password.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
  }

  // Look up the invite
  const invite = await safeQuery<{
    id: string;
    email: string;
    role: string;
    status: string;
    invited_by: string;
  }>(
    "SELECT id, email, role, status, invited_by FROM instinct_invites WHERE token = $1 LIMIT 1",
    [body.token],
  );

  if (invite.fromCache) {
    // Shadow mode: pretend it worked
    const memberId = `tm_${randomUUID().slice(0, 12)}`;
    trackEvent("system.team_invite_accepted", memberId, "dev", { mode: "shadow" });
    return NextResponse.json({ member_id: memberId });
  }

  if (invite.rows.length === 0) {
    return NextResponse.json({ error: "Invalid or expired invite token" }, { status: 404 });
  }

  const inv = invite.rows[0];
  if (inv.status !== "pending") {
    return NextResponse.json({ error: "Invite already accepted" }, { status: 409 });
  }

  // Create the team member
  const memberId = `tm_${randomUUID().slice(0, 12)}`;
  const passwordHash = hashPassword(body.password);
  const name = body.name || inv.email.split("@")[0];

  await safeQuery(
    `INSERT INTO apex_team_members (id, email, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [memberId, inv.email, name, inv.role, passwordHash],
  );

  // Mark invite as accepted
  await safeQuery(
    "UPDATE instinct_invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1",
    [inv.id],
  );

  trackEvent("system.team_invite_accepted", memberId, inv.role, {
    invite_id: inv.id,
    invited_by: inv.invited_by,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: memberId, role: inv.role },
    action: "team.invite.accepted",
    resourceType: "team_invite",
    resourceId: inv.id,
    afterState: {
      member_id: memberId,
      email: inv.email,
      role: inv.role,
      invited_by: inv.invited_by,
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ member_id: memberId });
}
