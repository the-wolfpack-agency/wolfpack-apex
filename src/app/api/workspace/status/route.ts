/**
 * /api/workspace/status — workspace setup completion status.
 *
 * Returns which setup steps are complete so the dashboard can show
 * a first-run banner and the setup wizard can resume from the right step.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check workspace name
  const workspace = await safeQuery<{ name: string; setup_complete: boolean }>(
    "SELECT name, setup_complete FROM instinct_workspace WHERE id = 'default' LIMIT 1",
  );

  // If setup_complete was explicitly set, short-circuit
  if (workspace.rows[0]?.setup_complete) {
    return NextResponse.json({
      complete: true,
      steps: { profile: true, team: true, integrations: true },
    });
  }

  // Check team member count
  const team = await safeQuery<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM apex_team_members WHERE is_active = true",
  );

  // Check integrations (Microsoft, QuickBooks, Plaud)
  const integrations = await safeQuery<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM (
      SELECT 1 FROM apex_integrations WHERE provider IN ('microsoft', 'quickbooks', 'plaud') AND status = 'connected'
      LIMIT 1
    ) sub`,
  );

  const hasWorkspaceName = !!workspace.rows[0]?.name && workspace.rows[0].name !== "My Workspace";
  const teamCount = team.rows[0]?.count ?? 0;
  const profileComplete = hasWorkspaceName && teamCount >= 1;
  const teamComplete = teamCount >= 2;
  const integrationsComplete = (integrations.rows[0]?.count ?? 0) > 0;

  // Shadow mode: nothing is complete
  if (workspace.fromCache) {
    return NextResponse.json({
      complete: false,
      steps: { profile: false, team: false, integrations: false },
    });
  }

  const complete = profileComplete && teamComplete && integrationsComplete;

  return NextResponse.json({
    complete,
    steps: {
      profile: profileComplete,
      team: teamComplete,
      integrations: integrationsComplete,
    },
  });
}
