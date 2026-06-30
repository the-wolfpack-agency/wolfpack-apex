/**
 * POST /api/auth/mfa/verify — confirm a pending enrollment with a TOTP code.
 *
 *   { code: "123456" }
 *   -> 200 { ok: true, recoveryCodes: [...] }  (codes shown ONCE)
 *   -> 400 bad/missing code, OR a code that doesn't verify (bad_code)
 *   -> 401 unauthenticated
 *   -> 403 missing account.manage_mfa
 *
 * Self-service + workspace/user scoped via the verified JWT — no IDOR. The
 * recovery codes are returned plaintext exactly once here; only their SHA-256
 * hashes are persisted.
 *
 * NON-ENFORCING: confirming MFA does not alter login/middleware/refresh.
 * Security-relevant => recordAudit (hash-chained).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { confirmMfa } from "@/lib/auth/mfa";

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
  const code = typeof (body as { code?: unknown })?.code === "string" ? (body as { code: string }).code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "code must be 6 digits" }, { status: 400 });
  }

  const result = await confirmMfa({ userId: user.id, workspaceId: user.workspaceId, code });

  if (!result.ok) {
    // Failed challenge is itself security-relevant: audit + analytics it so the
    // learning loop / SOC can see brute-force attempts on a user's own enrollment.
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "auth.mfa.verify_failed",
      resourceType: "admin_mfa",
      resourceId: user.id,
      afterState: { reason: result.reason },
      ...extractRequestMetadata(req),
    });
    trackEvent("auth.mfa_challenge_failed", user.id, user.role, { reason: result.reason });
    const status = result.reason === "no_enrollment" ? 400 : 400;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  }

  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "auth.mfa.verified",
    resourceType: "admin_mfa",
    resourceId: user.id,
    afterState: { confirmed: true, recovery_codes_issued: result.recoveryCodes.length },
    ...extractRequestMetadata(req),
  });
  trackEvent("auth.mfa_verified", user.id, user.role, {
    recovery_codes_issued: result.recoveryCodes.length,
  });

  return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes });
}
