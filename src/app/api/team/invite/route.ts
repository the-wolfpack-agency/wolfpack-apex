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
import {
  buildAcceptUrl,
  sendInviteEmail,
  type InviteEmailArgs,
  type InviteEmailResult,
} from "@/lib/mail/send-invite";

interface InvitePayload {
  email: string;
  role: string;
}

interface InviteResult {
  id: string;
  email: string;
  role: string;
  token: string;
  acceptUrl: string;
  emailDelivered: boolean;
  emailReason?: string;
}

const VALID_ROLES = ["ceo", "cto", "evp", "dev", "sales", "ops", "hr"];

/**
 * Optional `mailer` injection seam — tests can pass a stub via the
 * second argument to POST, which Next.js does NOT call with extra
 * arguments. To avoid breaking the route signature, the contract test
 * imports `inviteFlow` directly.
 */
export async function inviteFlow(
  req: NextRequest,
  mailer?: (a: InviteEmailArgs) => Promise<InviteEmailResult>,
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.invites) || body.invites.length === 0) {
    return NextResponse.json({ error: "invites array required" }, { status: 400 });
  }

  const invites: InvitePayload[] = body.invites;

  for (const inv of invites) {
    if (!inv.email || typeof inv.email !== "string" || !inv.email.includes("@")) {
      return NextResponse.json({ error: `Invalid email: ${inv.email}` }, { status: 400 });
    }
    if (!inv.role || !VALID_ROLES.includes(inv.role)) {
      return NextResponse.json({ error: `Invalid role: ${inv.role}` }, { status: 400 });
    }
    // Canonical-case the email at the boundary so the team_members row
    // we eventually write (in /api/team/accept) matches the login
    // lookup, which is LOWER(email). The dialog client already
    // lowercases — this is defense for direct API callers.
    inv.email = inv.email.trim().toLowerCase();
  }

  /* Prefer the real display name from instinct_team_members. The
     email-local-part fallback produced ugly subjects like "cto invited
     you to Wolfpack Instinct" when the inviter was the demo account or
     hadn't set a name. */
  const inviterName =
    (typeof user.name === "string" && user.name.trim().length > 0
      ? user.name.trim()
      : null) ||
    (typeof user.email === "string" ? user.email.split("@")[0] : user.role);

  const results: InviteResult[] = [];

  for (const inv of invites) {
    const id = `inv_${randomUUID().slice(0, 12)}`;
    const token = randomUUID();

    /* Invites grant membership to the INVITER's workspace. When the
       new user accepts, they join this workspace and never inherit a
       different one from cookies or query strings. */
    await safeQuery(
      `INSERT INTO instinct_invites (id, email, role, token, status, invited_by, workspace_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       ON CONFLICT (token) DO NOTHING`,
      [id, inv.email, inv.role, token, user.id, user.workspaceId],
    );

    trackEvent("system.team_member_invited", user.id, user.role, {
      invite_id: id,
      invited_email: inv.email,
      invited_role: inv.role,
    });

    const acceptUrl = buildAcceptUrl(token);
    const emailResult = await sendInviteEmail(
      {
        to: inv.email,
        inviterName,
        inviterEmail: typeof user.email === "string" ? user.email : "",
        role: inv.role,
        acceptUrl,
      },
      mailer,
    );

    results.push({
      id,
      email: inv.email,
      role: inv.role,
      token,
      acceptUrl,
      emailDelivered: emailResult.delivered,
      emailReason: emailResult.reason,
    });
  }

  const meta = extractRequestMetadata(req);
  for (const inv of results) {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "team.invite.sent",
      resourceType: "team_invite",
      resourceId: inv.id,
      afterState: {
        email: inv.email,
        role: inv.role,
        email_delivered: inv.emailDelivered,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
  }

  return NextResponse.json({ invites: results }, { status: 201 });
}

export async function POST(req: NextRequest) {
  /* Explicit auth check at the POST handler so static-analysis can
     see the gate without following the inviteFlow indirection.
     inviteFlow itself ALSO calls requireCapability (defense in depth,
     same workspace + capability gate). */
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return inviteFlow(req);
}
