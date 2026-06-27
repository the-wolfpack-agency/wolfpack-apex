/**
 * GET /api/cron/engagement-sweep - the autonomy heartbeat.
 *
 * For every opted-in platform (one that has been profiled), re-run the full
 * engagement (scan -> profile -> recommend) so a deployed OGIAM keeps the
 * findings, system map, and recommendations current without anyone clicking a
 * button. Read-only against the target; recordScan handles dedup + auto-resolve
 * + critical alerting, so this never double-alerts and never executes anything.
 *
 * Two auth paths (mirrors the other crons):
 *   1. Cron: Authorization: Bearer ${CRON_SECRET}. Vercel Cron hits this.
 *   2. User: requireCapability(req, "settings.manage_team") for a manual sweep.
 * Never 500s on a recoverable error. BUT a failure is no longer SILENT: the sweep
 * runs through runSweepWithHealth, which records every run in the
 * instinct_sweep_runs ledger, captures each target's outcome (a target that
 * threw is recorded as a failure, the sweep continues), derives ok/partial/failed
 * status, and ALERTS the operator via the existing notifications layer on a
 * transition into an unhealthy state. The route still returns 200 so the cron
 * health monitor stays green - but a broken sweep now surfaces immediately.
 */
import { NextRequest, NextResponse } from "next/server";
import { runDueEngagements } from "@/lib/platform-scan/engage/orchestrator";
import { trackEvent } from "@/lib/analytics";
import { requireCapability } from "@/lib/auth/require-capability";
import { runSweepWithHealth, engagementOutcome } from "@/lib/platform-scan/sweep-health";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function runSweep(actorId: string, actorRole: string): Promise<NextResponse> {
  // runSweepWithHealth never throws: a top-level orchestrator throw is caught,
  // recorded as a `failed` run, alerted, and returned as results=[]. So the
  // cron's "never 500" contract holds while the failure is now VISIBLE.
  const { results, health } = await runSweepWithHealth({
    kind: "engagement",
    actor: { id: actorId, role: actorRole },
    run: () => runDueEngagements("default"),
    outcome: engagementOutcome,
  });

  const assessed = results.filter((r) => r.profiled).length;
  const criticals = results.reduce((n, r) => n + r.criticalCount, 0);
  trackEvent("platform.engagement_run", actorId, actorRole, {
    platform: "sweep",
    findings: results.reduce((n, r) => n + r.findingCount, 0),
    criticals,
    auto_resolved: results.reduce((n, r) => n + r.autoResolvedCount, 0),
    recommendations: results.reduce((n, r) => n + r.recommendationCount, 0),
  });

  // A top-level throw yields results=[] and status "failed": report it as
  // skipped (preserving the historical shape) but with the health summary so the
  // outcome is no longer zeroed-and-silent.
  if (health.status === "failed" && results.length === 0) {
    return NextResponse.json({ ok: true, assessed: 0, total: 0, skipped: true, health });
  }
  return NextResponse.json({
    ok: true,
    assessed,
    total: results.length,
    criticals,
    results,
    health,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) return runSweep("cron", "system");
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep(auth.user.id, auth.user.role);
}
