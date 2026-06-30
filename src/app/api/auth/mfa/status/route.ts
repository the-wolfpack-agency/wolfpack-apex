/**
 * GET /api/auth/mfa/status — read the CALLER's MFA enrollment state.
 *
 *   -> 200 { enrolled, confirmed, recoveryCodesRemaining, confirmedAt }
 *   -> 401 unauthenticated
 *   -> 403 missing account.manage_mfa
 *
 * Read-only, workspace/user scoped via the verified JWT (no IDOR). No mutation,
 * so no recordAudit (matches the read AUDIT_ALLOWLIST convention). The settings
 * UI calls this on mount to decide which state to render.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { mfaStatus } from "@/lib/auth/mfa";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "account.manage_mfa");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const status = await mfaStatus({ userId: user.id, workspaceId: user.workspaceId });
  return NextResponse.json(status);
}
