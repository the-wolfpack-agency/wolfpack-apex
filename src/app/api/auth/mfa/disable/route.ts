/**
 * POST /api/auth/mfa/disable — turn off MFA for the CALLER. Idempotent.
 *
 *   -> 200 { ok: true, wasEnrolled }
 *   -> 401 unauthenticated
 *   -> 403 missing account.manage_mfa
 *
 * Self-service + workspace/user scoped via the verified JWT — a user can only
 * disable THEIR OWN MFA, never another user's (no IDOR).
 *
 * NON-ENFORCING: since MFA is never required by any gate in this PR, disabling
 * it changes nothing about login/middleware/refresh either.
 * Security-relevant => recordAudit (hash-chained).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { disableMfa } from "@/lib/auth/mfa";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "account.manage_mfa");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { wasEnrolled } = await disableMfa({ userId: user.id, workspaceId: user.workspaceId });

  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "auth.mfa.disabled",
    resourceType: "admin_mfa",
    resourceId: user.id,
    beforeState: { enrolled: wasEnrolled },
    afterState: { enrolled: false },
    ...extractRequestMetadata(req),
  });
  trackEvent("auth.mfa_disabled", user.id, user.role, { was_enrolled: wasEnrolled });

  return NextResponse.json({ ok: true, wasEnrolled });
}
