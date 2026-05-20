/**
 * /api/team/accept — accept a team invite and set a password.
 *
 * Public endpoint (no auth required — the user is accepting an invite).
 *
 * PUBLIC: invite-token acceptance flow — the invitee has no session yet;
 * identity is proven by the single-use signed token in the request body.
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

  if (typeof body.password !== "string" || body.password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  // Look up the invite (migration 134 added expires_at — read it so we
  // can return a clear 410 Gone instead of a generic 404 when the
  // window has lapsed; the UI hints at "ask your admin to resend.")
  const invite = await safeQuery<{
    id: string;
    email: string;
    role: string;
    status: string;
    invited_by: string;
    expires_at: string | Date | null;
    workspace_id: string | null;
  }>(
    "SELECT id, email, role, status, invited_by, expires_at, workspace_id FROM instinct_invites WHERE token = $1 LIMIT 1",
    [body.token],
  );

  if (invite.fromCache) {
    // Shadow mode: pretend it worked. No email available — caller will
    // fall back to a clean /login redirect with no email pre-fill.
    const memberId = `tm_${randomUUID().slice(0, 12)}`;
    trackEvent("system.team_invite_accepted", memberId, "dev", { mode: "shadow" });
    return NextResponse.json({ member_id: memberId });
  }

  if (invite.rows.length === 0) {
    return NextResponse.json({ error: "Invalid invite token" }, { status: 404 });
  }

  const inv = invite.rows[0];
  if (inv.status !== "pending") {
    return NextResponse.json({ error: "Invite already accepted" }, { status: 409 });
  }
  if (inv.expires_at) {
    const expMs =
      inv.expires_at instanceof Date
        ? inv.expires_at.getTime()
        : Date.parse(String(inv.expires_at));
    if (!Number.isNaN(expMs) && expMs < Date.now()) {
      trackEvent("system.team_invite_expired", inv.id, inv.role, {
        invite_id: inv.id,
        invited_email: inv.email,
      });
      return NextResponse.json(
        {
          error: "Invite has expired",
          hint: "Ask your admin to resend the invite.",
        },
        { status: 410 },
      );
    }
  }

  // Create the team member
  const memberId = `tm_${randomUUID().slice(0, 12)}`;
  const passwordHash = hashPassword(body.password);
  const name = body.name || inv.email.split("@")[0];

  /* New member joins the invite's workspace (the inviter's tenant).
     Pre-migration-137 invites have a NULL workspace_id — fall back
     to "default" so legacy invite links still work. */
  const joinWorkspace = inv.workspace_id ?? "default";
  await safeQuery(
    `INSERT INTO instinct_team_members (id, email, name, role, password_hash, is_active, workspace_id)
     VALUES ($1, $2, $3, $4, $5, true, $6)`,
    [memberId, inv.email, name, inv.role, passwordHash, joinWorkspace],
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

  // Return the invited email so /accept-invite can hand it to /login
  // for pre-fill. Operators kept mistyping their own email on the
  // login form and hitting "Invalid credentials" — the invited email
  // is the only one that matches the row we just wrote.
  return NextResponse.json({ member_id: memberId, email: inv.email });
}
