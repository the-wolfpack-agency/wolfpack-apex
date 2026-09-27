/**
 * GET /api/admin/ai-code/history
 *
 * The factory's run history + quality read: recent pipeline runs (newest first),
 * an overall + per-model grade, and per-model drift flags. Pure reads over the
 * persisted `ai_code.pipeline_run` event stream, workspace-scoped.
 *
 * Capability + secure_agent entitlement gated. Never 500s on an empty history.
 * Returns: 200 { runs, grade, drift } | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { listPipelineRuns, toRunRecords } from "@/lib/ai-code/runs";
import { gradeRuns, detectDrift } from "@/lib/ai-code/grading";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const limParam = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(limParam) && limParam > 0 ? Math.min(limParam, 200) : 50;

  const runs = await listPipelineRuns(auth.user.workspaceId, limit);
  const records = toRunRecords(runs);
  const grade = gradeRuns(records);
  const drift = detectDrift(records);

  return NextResponse.json({ runs, grade, drift });
}
