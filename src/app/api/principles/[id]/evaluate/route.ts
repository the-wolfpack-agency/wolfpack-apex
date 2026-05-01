/**
 * POST /api/principles/[id]/evaluate — fan out evaluation for one
 * principle across the entire org, on demand. Used by the manager
 * UI's "Run now" button so leadership can refresh observations
 * without waiting for the cron tick.
 *
 * Awaits the runner so the caller gets a real summary back
 * (binding/user/observation counts), unlike the fire-and-forget
 * triggers on create/edit. Bounded by Vercel's serverless-function
 * timeout — for very large orgs this should still finish under 30s
 * because each principle has at most a handful of bindings.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { getActivePrincipleById } from "@/lib/principles/store";
import { evaluatePrinciples } from "@/lib/principles/evaluate-runner";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const principle = await getActivePrincipleById(id);
  if (!principle) {
    return NextResponse.json(
      { error: "principle not found or retired" },
      { status: 404 },
    );
  }
  const result = await evaluatePrinciples([principle], {
    forceBootstrap: true,
  });
  trackEvent("principle.observations_recorded", user.id, user.role, {
    trigger: "manual",
    principle_id: principle.id,
    binding_count: result.bindingCount,
    user_count: result.userCount,
    observation_count: result.observationCount,
    failure_count: result.failureCount,
  });
  return NextResponse.json({
    ok: true,
    bindings: result.bindingCount,
    users: result.userCount,
    observations: result.observationCount,
    failures: result.failureCount,
    perValidator: result.perValidator,
    skippedReason: result.skippedReason,
  });
}
