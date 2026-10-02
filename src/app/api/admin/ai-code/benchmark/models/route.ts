/**
 * GET /api/admin/ai-code/benchmark/models
 *
 * The models the factory can benchmark in THIS environment: every registered
 * model whose provider is actually configured (an API key / deployment present).
 * It is the read side of the multi-model comparison - the operator sees which
 * models are available to run the same battery against, alongside the per-model
 * grades the history endpoint already returns for models that have runs.
 *
 * Pure read (reads only env-var presence via availableBenchmarkModels); no model
 * call, no spend. Auth + entitlement mirror the rest of the ai-code admin surface.
 *
 * Returns: 200 { models } | 401/403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { availableBenchmarkModels } from "@/lib/ai-code/model-benchmark";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const models = availableBenchmarkModels();
  return NextResponse.json({ models });
}
