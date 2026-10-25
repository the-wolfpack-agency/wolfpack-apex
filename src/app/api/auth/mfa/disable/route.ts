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
 *   { code?: "123456" }
 *   -> 403 { error: "mfa_code_required" | "bad_code" } when the enrollment is
 *      confirmed and the caller has neither a valid MFA proof for this browser
 *      nor a valid code. A stolen password alone must not remove a second factor.
 *
 * Security-relevant => recordAudit (hash-chained).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  disableMfa,
  canChangeEnrollment,
  readCookie,
  mfaChallengeLocked,
  recordMfaFailure,
} from "@/lib/auth/mfa";
import { MFA_PROOF_COOKIE } from "@/lib/crypto/mfa-proof";
import { clearAuthCookie } from "@/lib/crypto/cookies";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "account.manage_mfa");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body?.code === "string" ? body.code : null;
  if (code && mfaChallengeLocked(user.id)) {
    return NextResponse.json({ ok: false, error: "too_many_attempts" }, { status: 429 });
  }
  const stepUp = await canChangeEnrollment({
    userId: user.id,
    workspaceId: user.workspaceId,
    proofToken: readCookie(req, MFA_PROOF_COOKIE),
    code,
  });
  if (!stepUp.ok) {
    if (stepUp.reason === "bad_code") {
      recordMfaFailure(user.id);
      trackEvent("auth.mfa_challenge_failed", user.id, user.role, { reason: "bad_code", stage: "disable" });
    }
    return NextResponse.json({ ok: false, error: stepUp.reason }, { status: 403 });
  }

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

  const res = NextResponse.json({ ok: true, wasEnrolled });
  clearAuthCookie(res, MFA_PROOF_COOKIE);
  return res;
}
