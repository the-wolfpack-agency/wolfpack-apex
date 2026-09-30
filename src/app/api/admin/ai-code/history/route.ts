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
import { listPipelineRuns, toRunRecords, listRunRepos } from "@/lib/ai-code/runs";
import { gradeRuns, detectDrift } from "@/lib/ai-code/grading";
import { listProtections } from "@/lib/ai-code/protections";
import { gateSafetySummary } from "@/lib/gates/activity";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const url = new URL(req.url);
  const limParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limParam) && limParam > 0 ? Math.min(limParam, 200) : 50;
  // Optional per-site filter. "(self)" selects the self-hosted default; any
  // other value is an owner/name repo the factory built against.
  const repoParam = (url.searchParams.get("repo") || "").trim();
  const repo = repoParam || undefined;

  // The distinct site list is always the UNFILTERED set, so the selector keeps
  // every site even while one is focused.
  const repos = await listRunRepos(auth.user.workspaceId);
  const runs = await listPipelineRuns(auth.user.workspaceId, limit, repo);
  const records = toRunRecords(runs);
  const grade = gradeRuns(records);
  const drift = detectDrift(records);
  const protected_ = await listProtections(auth.user.workspaceId, 30);
  const gateSafety = await gateSafetySummary(auth.user.workspaceId, 200);

  return NextResponse.json({ runs, repos, repo: repo ?? null, grade, drift, protected: protected_, gateSafety });
}
