/**
 * POST /api/admin/ogiam/governance-alerts/scan — the governance drift alert sweep.
 *
 * Runs the governance-alert detector over the durable signals (red-team pass-rate
 * history, the ungoverned-AI-surface inventory), and for each NEW regression
 * (deduped via the instinct_governance_alerts table) fans a notification out
 * through the existing notifications layer and records it. This is what makes
 * governance OPERATIONAL: a regression is SEEN, once, without spamming.
 *
 * Two auth paths (mirrors /api/cron/ai-redteam): a CRON_SECRET bearer for Vercel
 * Cron, or settings.manage_team for an admin manual run. Never 500s on a
 * recoverable error: the scan result IS the signal, returned in the body.
 *
 * POST is the admin manual entrypoint; GET is the Vercel Cron entrypoint (Vercel
 * Cron issues GET with the CRON_SECRET bearer). Both share the same auth + run.
 *
 * Read-derived: it detects from existing data and SENDS a notification; the only
 * row it writes is the dedupe claim (so it does not re-alert) + the notification
 * rows (the notifications layer's own audit trail). It fires
 * ogiam.drift_alert_dispatched per dispatched alert. AUDIT_ALLOWLIST-ed for that
 * reason, same posture as the ai-redteam run and the ai-surfaces scan.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { scanAndDispatch } from "@/lib/ogiam/governance-alerts";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function run(
  workspaceId: string,
  actorId: string,
  actorRole: string,
): Promise<NextResponse> {
  const result = await scanAndDispatch({ workspaceId, actorId, actorRole });
  return NextResponse.json({
    ok: true,
    detected: result.detected,
    dispatched: result.dispatched,
    deduped: result.deduped,
    alerts: result.alerts,
  });
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return run("default", "cron", "system");
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return run(auth.user.workspaceId ?? "default", auth.user.id, auth.user.role);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
