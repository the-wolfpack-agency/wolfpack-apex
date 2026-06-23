/**
 * POST /api/admin/agents/[id]/baseline: capture a behavior baseline for an
 * agent (OGIAM drift detection).
 *
 * The baseline snapshots the agent's recent behavior distribution over the
 * OGIAM decision ledger (tool mix, risk-tier mix, block rate). Subsequent drift
 * checks compare a recent window to this snapshot; a critical shift auto-pauses
 * the agent. Capturing a baseline is how an admin says "this is normal for this
 * agent" so the gate can measure deviation from it.
 *
 * Capability: settings.manage_team (the same gate as the rest of the agent admin
 * surface; the people who manage the team review and govern agent principals).
 *
 * Workspace-scoped: only the caller's workspace. 404 when the agent does not
 * exist in this workspace so the absence is explicit, never a blank 201.
 *
 * captureBaseline is a read-derived snapshot (it reads the ledger and upserts a
 * baseline row) and fires agent.baseline_captured analytics; it makes no
 * domain-state mutation, so this route is allowlisted in AUDIT_ALLOWLIST rather
 * than calling recordAudit.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { captureBaseline } from "@/lib/agents/drift/store";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";

  const agent = await getAgent(agentId, workspaceId);
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const baseline = await captureBaseline(agentId, workspaceId);
  return NextResponse.json({ baseline }, { status: 201 });
}
