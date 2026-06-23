/**
 * POST /api/admin/agents/[id]/drift-check: run a behavior-drift check for an
 * agent on demand (OGIAM drift detection).
 *
 * Compares the agent's recent behavior window to its captured baseline, records
 * a drift event, and when the agent has drifted past the pause threshold the
 * underlying lib auto-pauses the agent and notifies the owner. This is the
 * interactive "run it now" twin of the hourly drift sweep cron.
 *
 * Capability: settings.manage_team (same gate as the rest of the agent admin
 * surface). Workspace-scoped: 404 when the agent does not exist in this
 * workspace, so the absence is explicit, never a blank 200.
 *
 * When the check auto-pauses the agent (result.action === "paused"), that is a
 * security-relevant lifecycle change on an AI principal (a credential the agent
 * holds is suspended), so it is hash-chained in the audit log with the drift
 * verdict + score. The check-without-pause path is observability only
 * (agent.drift_checked analytics fires inside the lib).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { runDriftCheck } from "@/lib/agents/drift/store";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await ctx.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const workspaceId = user.workspaceId ?? "default";

  const agent = await getAgent(agentId, workspaceId);
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await runDriftCheck(agentId, workspaceId);

  /* An auto-pause suspends a credential-holding AI principal, so it is a
     security-relevant lifecycle change. Hash-chain it with the drift verdict +
     score. recordAudit is best-effort and must not fail the request. */
  if (result.action === "paused") {
    try {
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "agent.auto_paused",
        resourceType: "agent",
        resourceId: agentId,
        afterState: { verdict: result.verdict, score: result.score },
        ...extractRequestMetadata(req),
      });
    } catch (err) {
      console.error("[admin/agents drift-check audit]", (err as Error).message);
    }
  }

  return NextResponse.json({ result });
}
