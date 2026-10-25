/**
 * POST /api/auth/mfa/enroll — begin an OPT-IN TOTP enrollment for the CALLER.
 *
 *   -> 200 { secret, otpauthUrl }  (secret seeds the authenticator app once)
 *   -> 401 unauthenticated
 *   -> 403 missing account.manage_mfa
 *
 * Self-service: the user enrolled is ALWAYS the authenticated caller (userId +
 * workspaceId come from the verified JWT, never request body) — no IDOR.
 *
 *   { code?: "123456" }  only needed to REPLACE a confirmed enrollment:
 *   -> 403 { error: "mfa_code_required" | "bad_code" } when one is confirmed and
 *      the caller has neither a valid MFA proof for this browser nor a code.
 *      Otherwise a stolen password could swap in the attacker's authenticator.
 *
 * Security-relevant => recordAudit (hash-chained), NOT the read AUDIT_ALLOWLIST.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import {
  enrollMfa,
  canChangeEnrollment,
  readCookie,
  mfaChallengeLocked,
  recordMfaFailure,
} from "@/lib/auth/mfa";
import { MFA_PROOF_COOKIE } from "@/lib/crypto/mfa-proof";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "account.manage_mfa");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body?.code === "string" ? body.code : null;
  if (code && mfaChallengeLocked(user.id)) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
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
      trackEvent("auth.mfa_challenge_failed", user.id, user.role, { reason: "bad_code", stage: "re_enroll" });
    }
    return NextResponse.json({ error: stepUp.reason }, { status: 403 });
  }

  const result = await enrollMfa({
    userId: user.id,
    workspaceId: user.workspaceId,
    account: user.email || user.id,
  });
  if (!result) {
    return NextResponse.json({ error: "could not start enrollment" }, { status: 500 });
  }

  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "auth.mfa.enroll_started",
    resourceType: "admin_mfa",
    resourceId: user.id,
    afterState: { confirmed: false },
    ...extractRequestMetadata(req),
  });

  trackEvent("auth.mfa_enrolled", user.id, user.role, { workspace_id: user.workspaceId ?? "default" });

  // The secret is returned ONCE so the authenticator app can be seeded; it is
  // stored only ENCRYPTED at rest (never plaintext). The QR is drawn client-side
  // from otpauthUrl, so no QR library ships server-side.
  return NextResponse.json({ secret: result.secret, otpauthUrl: result.otpauthUrl });
}
