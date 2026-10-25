/**
 * POST /api/auth/mfa/challenge: answer the sign-in MFA challenge.
 *
 *   { code: "123456" }  (a TOTP, or a single-use recovery code "a1b2c-3d4e5")
 *   -> 200 { ok: true, usedRecoveryCode, recoveryCodesRemaining }  + sets the
 *          HttpOnly MFA proof cookie (7 days, bound to this enrollment)
 *   -> 400 missing/malformed code, no confirmed enrollment, or a wrong code
 *   -> 401 unauthenticated
 *   -> 403 missing account.manage_mfa
 *   -> 429 too many wrong codes for this user (5 per 15 minutes)
 *
 * The caller is always the authenticated user (JWT), never a body field, so
 * there is no IDOR. This route is reachable while the admin MFA gate is
 * blocking everything else, because it is gated on `account.manage_mfa`.
 * Security-relevant => recordAudit (hash-chained) on pass and on failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  confirmedAtFor,
  verifyMfaCode,
  mfaStatus,
  mfaChallengeLocked,
  recordMfaFailure,
  clearMfaFailures,
  MFA_FAILURE_WINDOW_SECONDS,
  MFA_MAX_FAILURES,
} from "@/lib/auth/mfa";
import { issueMfaProof, MFA_PROOF_COOKIE, MFA_PROOF_TTL_SECONDS } from "@/lib/crypto/mfa-proof";
import { setAuthCookie } from "@/lib/crypto/cookies";

const CODE_SHAPE = /^(\d{6}|[0-9a-fA-F]{5}-?[0-9a-fA-F]{5})$/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "account.manage_mfa");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const raw = (body as { code?: unknown })?.code;
  const code = typeof raw === "string" ? raw.trim() : "";
  if (!CODE_SHAPE.test(code)) {
    return NextResponse.json({ error: "code must be a 6-digit code or a recovery code" }, { status: 400 });
  }

  if (mfaChallengeLocked(user.id)) {
    trackEvent("auth.mfa_challenge_rate_limited", user.id, user.role, {
      window_seconds: MFA_FAILURE_WINDOW_SECONDS,
      max_failures: MFA_MAX_FAILURES,
    });
    return NextResponse.json(
      { ok: false, error: "too_many_attempts" },
      { status: 429, headers: { "Retry-After": String(MFA_FAILURE_WINDOW_SECONDS) } },
    );
  }

  const confirmedAtMs = await confirmedAtFor(user.id, user.workspaceId);
  if (confirmedAtMs === null) {
    return NextResponse.json({ ok: false, error: "no_enrollment" }, { status: 400 });
  }

  const result = await verifyMfaCode({ userId: user.id, workspaceId: user.workspaceId, code });
  const meta = extractRequestMetadata(req);

  if (!result.ok) {
    recordMfaFailure(user.id);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "auth.mfa.challenge_failed",
      resourceType: "admin_mfa",
      resourceId: user.id,
      afterState: { reason: "bad_code" },
      ...meta,
    });
    trackEvent("auth.mfa_challenge_failed", user.id, user.role, { reason: "bad_code", stage: "sign_in" });
    return NextResponse.json({ ok: false, error: "bad_code" }, { status: 400 });
  }

  clearMfaFailures(user.id);
  const status = await mfaStatus({ userId: user.id, workspaceId: user.workspaceId });
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "auth.mfa.challenge_passed",
    resourceType: "admin_mfa",
    resourceId: user.id,
    afterState: { used_recovery_code: result.usedRecoveryCode },
    ...meta,
  });
  trackEvent("auth.mfa_challenge_passed", user.id, user.role, {
    used_recovery_code: result.usedRecoveryCode,
    recovery_codes_remaining: status.recoveryCodesRemaining,
  });

  const res = NextResponse.json({
    ok: true,
    usedRecoveryCode: result.usedRecoveryCode,
    recoveryCodesRemaining: status.recoveryCodesRemaining,
  });
  setAuthCookie(res, MFA_PROOF_COOKIE, issueMfaProof({ userId: user.id, confirmedAtMs }), MFA_PROOF_TTL_SECONDS, {
    sameSite: "Lax",
  });
  return res;
}
