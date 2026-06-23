/**
 * GET /api/admin/agents/[id]/scan: the human view of an agent's latest
 * self-onboarding scan (OGIAM).
 *
 * The agent persists its system model via POST /api/agents/scan (which returns
 * only a summary). This route lets an admin read the FULL stored model: every
 * tool the platform exposes, marked allowed/not for that agent's role, plus its
 * effective capabilities. It is how a human verifies what an agent learned and
 * what it is permitted to do.
 *
 * Capability: settings.manage_team (same gate as /api/admin/feedback and
 * /api/admin/ogiam/decisions, the people who manage the team are the people who
 * should review an agent's system model).
 *
 * Workspace-scoped: only the caller's workspace. 404 when the agent has no scan
 * (or does not exist in this workspace) so the absence is explicit, never a
 * blank 200.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getLatestScan } from "@/lib/agents/scan-store";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const scan = await getLatestScan(agentId, workspaceId);
  if (!scan) {
    return NextResponse.json({ error: "no_scan" }, { status: 404 });
  }

  return NextResponse.json({ scan });
}
