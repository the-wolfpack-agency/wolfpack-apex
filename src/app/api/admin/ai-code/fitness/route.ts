/**
 * GET /api/admin/ai-code/fitness - the Model Fitness payload, computed SERVER-SIDE.
 *
 * Why a route and not client math: the scorers live in modules that transitively
 * import the model registry + providers (and `capabilityMismatch` needs each
 * model's DECLARED registry tier). Computing here keeps that server-only code out
 * of the client bundle and lets the page just render JSON. It reuses the ONE set
 * of scorers (gradeRuns / rankModels / modelValueScores / observedCapability /
 * capabilityMismatch / detectDrift) - no second implementation.
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. Never throws.
 * Returns 200 { overall, models, drift } | 401/403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { listPipelineRuns, toRunRecords } from "@/lib/ai-code/runs";
import { gradeRuns, detectDrift, type ModelGrade } from "@/lib/ai-code/grading";
import { rankModels, modelValueScores } from "@/lib/ai-code/model-benchmark";
import { fromModelGrade, observedCapability, capabilityMismatch, type DeclaredTier } from "@/lib/ai-code/model-capability";
import { MODEL_REGISTRY } from "@/lib/ai/models/registry";

const FAILURE_KEYS: ReadonlyArray<readonly [keyof ModelGrade["failureProfile"], string]> = [
  ["brokenLocalImports", "broken imports"],
  ["phantomImports", "phantom imports"],
  ["incompleteFiles", "incomplete files"],
  ["removedExports", "removed exports"],
  ["anchorFailures", "anchor failures"],
  ["deepScanCritical", "security"],
];

function topFailure(g: ModelGrade): string {
  let label = "clean";
  let worst = 0;
  for (const [key, name] of FAILURE_KEYS) {
    const v = g.failureProfile[key] ?? 0;
    if (v > worst) { worst = v; label = `${name} ${Math.round(v * 100)}%`; }
  }
  return label;
}

const declaredTierOf = (model: string): DeclaredTier | null => {
  const spec = MODEL_REGISTRY.find((m) => m.id === model);
  return spec ? (spec.capabilityTier as DeclaredTier) : null;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const url = new URL(req.url);
  const limParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limParam) && limParam > 0 ? Math.min(limParam, 500) : 200;

  const runs = await listPipelineRuns(auth.user.workspaceId, limit);
  const grade = gradeRuns(toRunRecords(runs));
  const drift = detectDrift(toRunRecords(runs));
  const values = modelValueScores(grade.byModel);

  const models = rankModels(grade.byModel).map((m) => {
    const obs = observedCapability(fromModelGrade(m));
    const declared = declaredTierOf(m.model);
    const mismatch = declared ? capabilityMismatch(declared, fromModelGrade(m)) : null;
    return {
      model: m.model,
      n: m.n,
      readyRate: m.readyRate,
      firstPassRate: m.firstPassRate,
      value: values[m.model] ?? null,
      observedTier: obs.observedTier,
      confident: obs.confident,
      declaredTier: declared,
      verdict: mismatch ? mismatch.verdict : "unknown", // matches|below|above|unproven|unknown
      topFailure: topFailure(m),
    };
  });

  return NextResponse.json({
    overall: {
      readyRate: grade.readyRate,
      firstPassRate: grade.firstPassRate,
      escalationRate: grade.escalationRate,
      models: models.length,
    },
    models,
    drift,
  });
}
