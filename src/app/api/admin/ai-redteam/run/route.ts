/**
 * /api/admin/ai-redteam/run — run the adversarial corpus against the gate.
 *
 *   POST -> runs the red-team, persists the result, returns the report.
 *   GET  -> recent run history for the workspace.
 *
 * Deterministic + offline (it exercises the real gate path, no live model / no
 * network), so it is safe on demand or on a schedule. Read-derived assurance (no
 * domain mutation) - audit-allowlisted - and emits ai_redteam.* analytics.
 * Capability: settings.manage_team.
 *
 * Returns: 200 { report } | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { executeRedTeam } from "@/lib/ai-redteam/execute";
import { listRuns } from "@/lib/ai-redteam/store";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const runs = await listRuns(auth.user.workspaceId ?? "default");
  return NextResponse.json({ runs });
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
