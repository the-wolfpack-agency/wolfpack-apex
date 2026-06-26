import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listPendingApprovals, listAgentApprovalHistory } from "@/lib/agents/approvals/store";

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
  // ?agentId scopes the queue to one agent (used by the agent detail page).
  const agentId = req.nextUrl.searchParams.get("agentId") ?? undefined;
  const approvals = await listPendingApprovals(workspaceId, agentId);
  // ?history=1 (with agentId) also returns recent DECIDED approvals so the
  // human-in-the-loop section shows real activity, not just the pending queue.
  const wantsHistory = req.nextUrl.searchParams.get("history") === "1" && !!agentId;
  const history = wantsHistory ? await listAgentApprovalHistory(workspaceId, agentId!) : undefined;
  return NextResponse.json({ approvals, ...(history ? { history } : {}) });
}
