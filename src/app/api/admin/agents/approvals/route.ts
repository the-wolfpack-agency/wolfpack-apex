import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listPendingApprovals } from "@/lib/agents/approvals/store";

/**
 * GET /api/admin/agents/approvals -> pending agent write approvals for the
 * workspace. Gated on settings.manage_team (the same capability that manages
 * agents). The captured params are CRM field values only (no secrets), safe to
 * render in the approval queue UI.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";
  const approvals = await listPendingApprovals(workspaceId);
  return NextResponse.json({ approvals });
}
