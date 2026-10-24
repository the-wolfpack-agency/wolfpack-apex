/**
 * /api/admin/ai-redteam/run — run the fixed gate regression set against the gate.
 *
 *   POST -> runs the regression set, persists the result, returns the report.
 *   GET  -> recent run history for the workspace + the suite descriptor (what the
 *           suite is: a fixed regression set of N cases, not red-team coverage).
 *
 * Deterministic + offline (it exercises the real gate path, no live model / no
 * network), so it is safe on demand or on a schedule. Read-derived assurance (no
 * domain mutation) - audit-allowlisted - and emits ai_redteam.* analytics.
 * Capability: settings.manage_team.
 *
 * Returns: GET 200 { runs, suite } | POST 200 { report } | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { executeRedTeam } from "@/lib/ai-redteam/execute";
import { listRuns } from "@/lib/ai-redteam/store";
import { RED_TEAM_SUITE } from "@/lib/ai-redteam/suite";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const runs = await listRuns(auth.user.workspaceId ?? "default");
  return NextResponse.json({ runs, suite: RED_TEAM_SUITE });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { report } = await executeRedTeam({
    workspaceId: auth.user.workspaceId ?? "default",
    actorId: auth.user.id,
    actorRole: auth.user.role,
    source: "manual",
    nowIso: new Date().toISOString(),
  });

  return NextResponse.json({ report });
}
