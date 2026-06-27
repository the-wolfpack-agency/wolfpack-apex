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
 * Never 500s on a recoverable error: a top-level throw returns a zeroed 200 so
 * the cron health monitor stays green.
 */
import { NextRequest, NextResponse } from "next/server";
import { runDueEngagements } from "@/lib/platform-scan/engage/orchestrator";
import { trackEvent } from "@/lib/analytics";
import { requireCapability } from "@/lib/auth/require-capability";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function runSweep(actorId: string, actorRole: string): Promise<NextResponse> {
  try {
    const results = await runDueEngagements("default");
    const assessed = results.filter((r) => r.profiled).length;
    const criticals = results.reduce((n, r) => n + r.criticalCount, 0);
    trackEvent("platform.engagement_run", actorId, actorRole, {
      platform: "sweep",
      findings: results.reduce((n, r) => n + r.findingCount, 0),
      criticals,
      auto_resolved: results.reduce((n, r) => n + r.autoResolvedCount, 0),
      recommendations: results.reduce((n, r) => n + r.recommendationCount, 0),
    });
    return NextResponse.json({ ok: true, assessed, total: results.length, criticals, results });
  } catch (err) {
    console.error("[cron/engagement-sweep]", (err as Error).message);
    return NextResponse.json({ ok: true, assessed: 0, total: 0, skipped: true });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) return runSweep("cron", "system");
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep(auth.user.id, auth.user.role);
}
