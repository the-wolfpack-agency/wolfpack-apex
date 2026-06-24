/**
 * GET /api/admin/agents/[id]/log: the per-agent action trail.
 *
 * Returns the TRUE prompt-to-response detail for a governed agent: every OGIAM
 * decision recorded under the agent's identity (the redacted INPUT, the
 * deterministic outcome, and the tamper-evident hashes) joined to its recorded
 * action OUTCOME (the redacted RESULT). This is the human view an admin uses to
 * audit exactly what an agent proposed AND what actually happened.
 *
 * Capability: settings.manage_team (same gate as the rest of the agent admin
 * surface). Workspace-scoped: every read is scoped to the caller's workspace,
 * and a 404 is returned for an unknown agent so the trail can never leak another
 * workspace's existence. Read-only, so no audit entry. An empty trail is an
 * explicit empty state ({ entries: [] }), never a blank page.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getAgent } from "@/lib/agents/store";
import { listAgentActionTrail } from "@/lib/ogiam/queries";

export async function GET(
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

  // Unknown agent (or another workspace's agent) -> 404, never a leak.
  const agent = await getAgent(agentId, workspaceId);
  if (!agent) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }

  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit =
    rawLimit !== null && rawLimit !== "" ? Number(rawLimit) : undefined;

  const entries = await listAgentActionTrail(workspaceId, agentId, limit);

  trackEvent("agent.log_viewed", auth.user.id, auth.user.role, {
    agent_id: agentId,
    decision_count: entries.length,
  });

  return NextResponse.json({ entries });
}
