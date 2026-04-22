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
      nextStep: "complete",
    });
  }

  // Check team member count
  const team = await safeQuery<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM instinct_team_members WHERE is_active = true",
  );

  // Check integrations. There is no single `*_integrations` table —
  // each provider has its own token/connection table written on
  // successful OAuth. Counting across all three means the step flips
  // complete as soon as ANY provider is connected. Tables are queried
  // separately so a missing table (safeQuery returns empty on error)
  // doesn't zero out the other two.
  const [ms, qbo, plaud] = await Promise.all([
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM instinct_ms_tokens"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM instinct_qbo_tokens"),
    safeQuery<{ count: number }>("SELECT COUNT(*)::int AS count FROM instinct_plaud_connections"),
  ]);
  const integrationsCount =
    (ms.rows[0]?.count ?? 0) +
    (qbo.rows[0]?.count ?? 0) +
    (plaud.rows[0]?.count ?? 0);

  const hasWorkspaceName = !!workspace.rows[0]?.name?.trim();
  const teamCount = team.rows[0]?.count ?? 0;
  const profileComplete = hasWorkspaceName && teamCount >= 1;
  const teamComplete = teamCount >= 2;
  const integrationsComplete = integrationsCount > 0;

  // Shadow mode: nothing is complete
  if (workspace.fromCache) {
    return NextResponse.json({
      complete: false,
      steps: { profile: false, team: false, integrations: false },
      nextStep: "profile",
    });
  }

  const complete = profileComplete && teamComplete && integrationsComplete;

  let nextStep: "profile" | "team" | "integrations" | "complete";
  if (!profileComplete) {
    nextStep = "profile";
  } else if (!teamComplete) {
    nextStep = "team";
  } else if (!integrationsComplete) {
    nextStep = "integrations";
  } else {
    nextStep = "complete";
  }

  return NextResponse.json({
    complete,
    steps: {
      profile: profileComplete,
      team: teamComplete,
      integrations: integrationsComplete,
    },
    nextStep,
  });
}
