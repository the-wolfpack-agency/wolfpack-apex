/**
 * POST /api/team/invite/resend — extend an existing pending invite's
 * expiration and re-deliver the invite email.
 *
 * Use case: a teammate (e.g. Max) didn't accept the invite before it
 * lapsed (or before the email rotted out of their inbox). An admin
 * clicks "Resend invite" and the same token gets a fresh 30-day
 * window + a new email goes out. No new invite row is created — the
 * accept link stays stable for audit trails.
 *
 * CTO/CEO only via the existing settings.manage_team capability.
 *
 * Body: { email: string }  (the invitee's email; the most-recent
 *                          pending invite for that email is the target)
 *
 * Response shapes:
 *   200 { id, email, role, token, acceptUrl, emailDelivered, emailReason }
 *   400 { error }            — bad body
 *   401 { error }            — no session (handled by requireCapability)
 *   403 { error }            — caller lacks settings.manage_team
 *   404 { error }            — no pending invite for that email
 *   409 { error }            — invite already accepted; nothing to resend
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  buildAcceptUrl,
  sendInviteEmail,
  type InviteEmailArgs,
  type InviteEmailResult,
} from "@/lib/mail/send-invite";

const RESEND_EXTENSION_DAYS = 30;

export async function resendFlow(
  req: NextRequest,
  mailer?: (a: InviteEmailArgs) => Promise<InviteEmailResult>,
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.email !== "string" || !body.email.includes("@")) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  const targetEmail = body.email.toLowerCase().trim();

  /* Pick the most-recent pending invite for that email. If there are
     multiple pending rows (legacy from before unique constraints) we
     bump the latest by created_at; older rows stay as-is — the latest
     is the one the user has been receiving emails about. */
  const found = await safeQuery<{
    id: string;
    email: string;
    role: string;
    token: string;
    status: string;
  }>(
    `SELECT id, email, role, token, status
       FROM instinct_invites
      WHERE LOWER(email) = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [targetEmail],
  );

  if (found.fromCache || found.rows.length === 0) {
    return NextResponse.json(
      { error: "No invite found for that email" },
      { status: 404 },
    );
  }

  const inv = found.rows[0];
  if (inv.status === "accepted") {
    return NextResponse.json(
      { error: "Invite already accepted — no resend needed" },
      { status: 409 },
    );
  }

  /* Extend expiry, ensure status is pending. */
  const extended = await safeQuery<{ expires_at: string | Date }>(
    `UPDATE instinct_invites
        SET expires_at = NOW() + ($2 || ' days')::interval,
            status = 'pending'
      WHERE id = $1
      RETURNING expires_at`,
    [inv.id, RESEND_EXTENSION_DAYS],
  );

  const acceptUrl = buildAcceptUrl(inv.token);
  const inviterName =
    typeof user.email === "string" ? user.email.split("@")[0] : user.role;
  const send = mailer ?? sendInviteEmail;
  const email = await send({
    to: inv.email,
    inviterName,
    inviterEmail: user.email ?? "",
    role: inv.role,
    acceptUrl,
  }).catch(() => ({ delivered: false, reason: "provider_error" as const }));

  trackEvent("system.team_invite_resent", user.id, user.role, {
    invite_id: inv.id,
    invited_email: inv.email,
    invited_role: inv.role,
    extension_days: RESEND_EXTENSION_DAYS,
    email_delivered: email.delivered,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "team.invite.resent",
    resourceType: "team_invite",
    resourceId: inv.id,
    afterState: {
      email: inv.email,
      role: inv.role,
      extension_days: RESEND_EXTENSION_DAYS,
      expires_at: extended.rows[0]?.expires_at ?? null,
      email_delivered: email.delivered,
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    token: inv.token,
    acceptUrl,
    emailDelivered: email.delivered,
    emailReason: email.reason ?? "ok",
  });
}

export async function POST(req: NextRequest) {
  /* Explicit auth check at the POST handler so static-analysis can
     see the gate without following the resendFlow indirection.
     resendFlow itself ALSO calls requireCapability (defense in depth,
     same workspace + capability gate). */
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return resendFlow(req);
}
