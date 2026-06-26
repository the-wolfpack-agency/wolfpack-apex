/**
 * GET /api/cron/integration-health: the nightly integration-health sweep.
 *
 * Walks every workspace that has an active connector, runs a connectivity probe
 * + a schema probe per CRM object, persists each result to integration_health,
 * and emits integration.health_drift_detected when a vendor's schema hash has
 * changed since the last good probe. This is how a client's CRM breaking
 * silently (a removed field, a revoked token, an API version bump) surfaces
 * BEFORE it breaks an agent's workflow - the probe is the signal, the drift
 * event feeds the learning loop.
 *
 * Two auth paths (mirrors /api/cron/agent-drift):
 *   1. Cron path: Authorization: Bearer ${CRON_SECRET}. Vercel Cron hits this on
 *      the nightly schedule. Returns false when CRON_SECRET is unset (local dev).
 *   2. User path: requireCapability(req, "settings.manage_team") for an admin
 *      triggering a manual sweep.
 *
 * Never 500s on a recoverable condition: the sweep is best-effort and a
 * top-level throw returns a zeroed 200 so the cron health-monitor stays green.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { sweepAllWorkspaces } from "@/lib/health/integration-probes";
import { trackEvent } from "@/lib/analytics";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function runSweep(actorId: string, actorRole: string): Promise<NextResponse> {
  try {
    const result = await sweepAllWorkspaces();
    trackEvent("integration.health_sweep", actorId, actorRole, {
      workspaces: result.workspaces,
      probes: result.probes,
      drift_count: result.drifted.length,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/integration-health]", (err as Error).message);
    return NextResponse.json({ ok: true, workspaces: 0, probes: 0, drifted: [] });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return runSweep("cron", "system");
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep(auth.user.id, auth.user.role);
}
