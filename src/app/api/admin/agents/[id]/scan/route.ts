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
 *
 * POST /api/admin/agents/[id]/scan: the human/admin trigger for the SAME
 * self-onboarding scan the agent runs on itself. The agent path
 * (POST /api/agents/scan) is agent-credential gated; this is the manager view,
 * gated on settings.manage_team, so an admin can make an agent (re)learn the
 * platform from the dashboard without the agent's token.
 *
 * It reuses the exact lib the agent path uses (runSelfOnboardingScan + saveScan),
 * so the persisted model is identical regardless of who triggered it. An admin
 * cannot make an inactive agent scan: a revoked or paused agent returns 409
 * agent_not_active (the admin twin of the agent route's 403 state guard). The
 * mutation is hash-chained in the audit log (agent.scan_completed) because making
 * an AI principal re-introspect its permissions is a security-relevant action,
 * and it emits agent.scan_completed analytics with source "admin".
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { runSelfOnboardingScan } from "@/lib/agents/scan";
import { saveScan, getLatestScan } from "@/lib/agents/scan-store";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";

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

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }

  const workspaceId = user.workspaceId ?? "default";

  const agent = await getAgent(agentId, workspaceId);
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  /* An admin cannot make an inactive agent scan. We mirror the agent route's
     state guard (it rejects revoked/paused) but surface it as an explicit 409
     to the admin caller: the request named a real agent that is simply not in a
     scannable state, not a missing one. */
  if (agent.state === "revoked" || agent.state === "paused") {
    return NextResponse.json({ error: "agent_not_active" }, { status: 409 });
  }

  /* Reuse the exact deterministic introspection the agent runs on itself. An
     admin trigger produces identical data; we do not reimplement scanning. */
  const model = runSelfOnboardingScan({
    agentId,
    role: agent.role,
    workspaceId,
  });
  await saveScan(model);

  /* Making an AI principal re-introspect its permitted tools is a
     security-relevant action on a credential-holding principal, so hash-chain
     it. recordAudit is best-effort and must never fail the scan. */
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "agent.scan_completed",
      resourceType: "agent",
      resourceId: agentId,
      afterState: { tool_count: model.tools.length, scan_version: model.scanVersion },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[admin/agents scan audit]", (err as Error).message);
  }

  trackEvent("agent.scan_completed", agentId, "agent", {
    agent_id: agentId,
    workspace_id: workspaceId,
    tool_count: model.tools.length,
    triggered_by: user.id,
    source: "admin",
  });

  return NextResponse.json({
    ok: true,
    summary: model.summary,
    scan_version: model.scanVersion,
    tool_count: model.tools.length,
  });
}
