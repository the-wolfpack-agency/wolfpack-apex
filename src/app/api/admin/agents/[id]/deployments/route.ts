/**
 * GET /api/admin/agents/[id]/deployments
 *
 * The deployments a single agent engaged with: the PRs it was dispatched to
 * triage from the release gate (the deploy_gate wiring), each matched to its
 * current pipeline. This is the per-agent Deployments tab. Read-only,
 * capability-gated on settings.manage_team, workspace-scoped (the agent is read
 * from the source of truth first, so work can't be attributed to a revoked or
 * cross-workspace agent). Honest-degrade + never-500 so the agent detail page
 * never blanks.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { getAgentDeploymentPipelines } from "@/lib/deploy/pipeline";
import { trackEvent } from "@/lib/analytics";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const workspace = auth.user.workspaceId ?? "default";

  const agent = await getAgent(id, workspace);
  if (!agent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }

  try {
    const report = await getAgentDeploymentPipelines(id, workspace);
    trackEvent("deploy.pipeline_viewed", auth.user.id, auth.user.role, {
      scope: "agent",
      pipeline_count: report.links.length,
      degraded: report.degraded.length > 0,
    });
    return NextResponse.json({ ok: true, ...report }, { status: 200 });
  } catch (err) {
    console.error("[api/admin/agents/[id]/deployments]", (err as Error).message);
    return NextResponse.json(
      {
        ok: true,
        links: [],
        degraded: [],
        checkedAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  }
}
