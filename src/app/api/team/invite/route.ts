/**
 * /api/team/invite — invite team members by email + role.
 *
 * CTO/CEO only. Creates invite records with unique tokens.
 * In shadow mode (no DB), returns success with generated IDs.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { randomUUID } from "crypto";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

interface InvitePayload {
  email: string;
  role: string;
}

const VALID_ROLES = ["ceo", "cto", "dev", "sales", "ops", "hr"];

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.invites) || body.invites.length === 0) {
    return NextResponse.json({ error: "invites array required" }, { status: 400 });
  }

  const invites: InvitePayload[] = body.invites;

  // Validate
  for (const inv of invites) {
    if (!inv.email || typeof inv.email !== "string" || !inv.email.includes("@")) {
      return NextResponse.json({ error: `Invalid email: ${inv.email}` }, { status: 400 });
    }
    if (!inv.role || !VALID_ROLES.includes(inv.role)) {
      return NextResponse.json({ error: `Invalid role: ${inv.role}` }, { status: 400 });
    }
  }

  const results: { id: string; email: string; role: string; token: string }[] = [];

  for (const inv of invites) {
    const id = `inv_${randomUUID().slice(0, 12)}`;
    const token = randomUUID();

    await safeQuery(
      `INSERT INTO instinct_invites (id, email, role, token, status, invited_by)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (token) DO NOTHING`,
      [id, inv.email, inv.role, token, user.id],
    );

    trackEvent("system.team_member_invited", user.id, user.role, {
      invite_id: id,
      invited_email: inv.email,
      invited_role: inv.role,
    });

    results.push({ id, email: inv.email, role: inv.role, token });
  }

  const meta = extractRequestMetadata(req);
  for (const inv of results) {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "team.invite.sent",
      resourceType: "team_invite",
      resourceId: inv.id,
      afterState: { email: inv.email, role: inv.role },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
  }

  return NextResponse.json({ invites: results }, { status: 201 });
}
