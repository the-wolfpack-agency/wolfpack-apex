import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getReleaseGate, fetchChangedFilesByPr } from "@/lib/deploy/release-gate";
import { planMergeOrder } from "@/lib/deploy/merge-plan";

/**
 * GET /api/admin/deployment/release-gate -> read the Production Release Gate:
 * every OPEN change targeting the production branch, classified into a state +
 * plain-language reason, so an operator can SEE what is blocking a prod deploy
 * instead of discovering it hours later by reading GitHub by hand.
 *
 * Capability: `settings.manage_team` - the SAME gate the /admin/deployment page
 * GET (deployment-readiness) uses, so the deployment surface shares one
 * permission boundary.
 *
 * HONEST DEGRADE: the lib returns `degraded` (with an empty blocking list) when
 * GitHub could not be reached - we pass that through verbatim so the UI shows
 * "could not check," never a false all-clear. The route still returns HTTP 200
 * with a well-formed gate; degradation is a field, not an error status.
 *
 * Mirrors the deployment-readiness route idiom: capability gate, run the lib,
 * trackEvent, return the result.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const gate = await getReleaseGate();

  trackEvent("deploy.release_gate_viewed", user.id, user.role, {
    blocking_count: gate.blocking.length,
    degraded: gate.degraded ? gate.degraded.detail : false,
  });

  // Recommended approval order: which change to promote first, which are
  // independent, and which need a quick rebase after an earlier one lands. We
  // only need file lists when the gate read succeeded and something is blocking;
  // when GitHub already degraded we skip the extra calls and pass that through.
  let plan;
  if (!gate.degraded && gate.blocking.length > 0) {
    const ready = gate.blocking.filter((c) => c.state === "ready_to_merge");
    const { filesByPr, degraded } = ready.length > 0
      ? await fetchChangedFilesByPr(ready.map((c) => c.number))
      : { filesByPr: {}, degraded: undefined };
    plan = planMergeOrder(gate.blocking, filesByPr, degraded ? { degraded } : {});

    trackEvent("deploy.merge_plan_computed", user.id, user.role, {
      ready_count: plan.readyCount,
      independent_count: plan.independentCount,
      has_overlaps: plan.hasOverlaps,
      degraded: plan.degraded ? plan.degraded.detail : false,
    });
  }

  return NextResponse.json({ ok: true, gate, plan: plan ?? null });
}
