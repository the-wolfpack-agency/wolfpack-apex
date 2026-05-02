/**
 * POST /api/principles/evaluate-all — fan out evaluation for EVERY
 * active principle. Wired to the "Run now (all)" button on the
 * /principles page so leadership can backfill observations after a
 * deploy, a config change, or a TRUNCATE without waiting on the
 * 4-hour periodic cron.
 *
 * Auth: leadership only (canReadTeamEvidence). Same gate as
 * /api/principles/[id]/evaluate so a member can't trigger an org-wide
 * Graph fan-out by hand.
 *
 * Idempotency: each principle's evaluation rides through the
 * evaluate-runner throttle. Concurrent calls share one in-flight run;
 * follow-up calls within the 60s cool-down emit
 * principle.evaluation_skipped(reason=throttled) and return zero
 * counts for that id rather than re-flooding the DB.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { listActivePrinciples } from "@/lib/principles/store";
import { evaluatePrinciples } from "@/lib/principles/evaluate-runner";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const principles = await listActivePrinciples();
  if (principles.length === 0) {
    return NextResponse.json({
      ok: true,
      principles: 0,
      observations: 0,
      perPrinciple: [],
    });
  }

  /* Run sequentially — bursts of evaluatePrinciples in parallel would
     hammer Microsoft Graph from the same per-user tokens. Sequential
     stays well under Graph throttling and inside Vercel's 60s
     serverless-function ceiling for the org sizes we serve today. */
  const perPrinciple: Array<{
    id: string;
    slug: string;
    observations: number;
    bindings: number;
    failures: number;
    skipped?: boolean;
  }> = [];
  let totalObservations = 0;
  for (const p of principles) {
    try {
      const result = await evaluatePrinciples([p], { forceBootstrap: true });
      totalObservations += result.observationCount;
      perPrinciple.push({
        id: p.id,
        slug: p.slug,
        observations: result.observationCount,
        bindings: result.bindingCount,
        failures: result.failureCount,
        skipped: result.observationCount === 0 && result.bindingCount === 0,
      });
    } catch (err) {
      /* One bad principle MUST NOT stop the rest. Track the failure
         and continue. */
      perPrinciple.push({
        id: p.id,
        slug: p.slug,
        observations: 0,
        bindings: 0,
        failures: 1,
      });
      trackEvent("principle.evaluation_failed", user.id, user.role, {
        trigger: "manual_all",
        principle_id: p.id,
        error: (err as Error).message,
      });
    }
  }

  trackEvent("principle.observations_recorded", user.id, user.role, {
    trigger: "manual_all",
    principle_count: principles.length,
    observation_count: totalObservations,
  });

  return NextResponse.json({
    ok: true,
    principles: principles.length,
    observations: totalObservations,
    perPrinciple,
  });
}
