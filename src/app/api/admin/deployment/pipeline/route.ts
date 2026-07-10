/**
 * GET /api/admin/deployment/pipeline
 *
 * The fleet-wide deployment pipeline: every recent production deploy plus the
 * in-flight PRs still blocking the next one, each stitched into an ordered
 * CI -> merge -> build -> promote -> verify -> health timeline. Read-only:
 * promotion stays the release gate's existing one-click action, so this route
 * mutates nothing and needs no audit entry. Capability-gated on
 * settings.manage_team. Honest-degrade: a per-source `degraded` array is passed
 * through (never a false all-clear), and any unexpected throw returns an empty,
 * degraded 200 so the deployment page never blanks.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getDeploymentPipelines } from "@/lib/deploy/pipeline";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  try {
    const workspace = auth.user.workspaceId ?? "default";
    const report = await getDeploymentPipelines({ limit: 15, workspaceId: workspace });
    trackEvent("deploy.pipeline_viewed", auth.user.id, auth.user.role, {
      scope: "fleet",
      pipeline_count: report.pipelines.length,
      degraded: report.degraded.length > 0,
    });

    // The cross-data signal: when the live deploy correlates with agent model
    // regressions, record it so the learning loop sees deploy -> agent-quality.
    const live = report.pipelines.find((p) => p.live && p.agentImpact);
    if (live?.agentImpact && live.agentImpact.regressionCount > 0) {
      trackEvent("deploy.agent_regression_correlated", auth.user.id, auth.user.role, {
        commit_sha: live.commitSha ?? "",
        regression_count: live.agentImpact.regressionCount,
        since: live.agentImpact.since,
      });
    }
    return NextResponse.json({ ok: true, ...report }, { status: 200 });
  } catch (err) {
    console.error("[api/admin/deployment/pipeline]", (err as Error).message);
    return NextResponse.json(
      {
        ok: true,
        pipelines: [],
        servingSha: null,
        checkedAt: new Date().toISOString(),
        degraded: [
          { source: "github", detail: "Could not compute the pipeline." },
        ],
      },
      { status: 200 },
    );
  }
}
