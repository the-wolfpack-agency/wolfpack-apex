/**
 * GET /api/auth/mfa/status: read the CALLER's MFA enrollment state and what
 * the admin MFA gate requires of them right now.
 *
 *   -> 200 { enrolled, confirmed, recoveryCodesRemaining, confirmedAt,
 *            enforced, required: null | "enroll" | "challenge" | "unavailable" }
 *   -> 401 unauthenticated
 *   -> 403 missing account.manage_mfa
 *
 * Read-only, workspace/user scoped via the verified JWT (no IDOR). No mutation,
 * so no recordAudit (matches the read AUDIT_ALLOWLIST convention). The settings
 * card reads it to pick a state; the dashboard layout reads `required` to send
 * an admin to /mfa before rendering pages whose API calls would be refused.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { mfaStatus, mfaRequirementFor, readCookie } from "@/lib/auth/mfa";
import { MFA_PROOF_COOKIE } from "@/lib/crypto/mfa-proof";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "account.manage_mfa");
  if (!auth.ok) return auth.response;
  const { user, capabilities } = auth;

  const status = await mfaStatus({ userId: user.id, workspaceId: user.workspaceId });
  const decision = await mfaRequirementFor({
    user,
    capabilities,
    proofToken: readCookie(req, MFA_PROOF_COOKIE),
  });
  return NextResponse.json({
    ...status,
    enforced: decision.subject && !decision.exempt,
    required: decision.required,
  });
}
