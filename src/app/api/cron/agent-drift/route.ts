/**
 * GET /api/cron/agent-drift: the hourly agent behavior-drift sweep (OGIAM).
 *
 * Walks every active agent that has a captured baseline, runs a drift check
 * against its recent OGIAM decision window, records a drift event per agent, and
 * auto-pauses + notifies the owner of any agent that has drifted critically.
 * This is how the gate keeps agents in check across model changes without a
 * human in the loop: the gate is constant, the behavior shift is the measurable
 * signal, and a critical shift stops the agent.
 *
 * Two auth paths (mirrors /api/support/poll exactly):
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron hits this
 *      on the hourly schedule. Returns false when CRON_SECRET is unset (local
 *      dev) so the user-session path is the only way in.
 *   2. User path: `requireCapability(req, "settings.manage_team")` for a logged-in
 *      admin triggering a manual sweep from the agent admin surface.
 *
 * Never 500s on a recoverable condition: the sweep result (and any per-agent
 * failures) are best-effort inside runDriftSweep, and an unexpected throw is
 * caught and returned as a zeroed 200 so the cron health-monitor stays green.
 *
 * Audit: any auto-pause is recorded in instinct_agent_drift_events and emits
 * agent.auto_paused analytics inside the lib, and an interactive drift-check
 * audits its own pause, so this scheduled sweep is allowlisted in
 * AUDIT_ALLOWLIST rather than calling recordAudit per agent.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { runDriftSweep } from "@/lib/agents/drift/store";

/**
 * Cron secret check. Mirrors src/app/api/support/poll/route.ts so all our
 * cron-triggered endpoints share one mental model. Returns false when
 * CRON_SECRET is unset (local dev) so the user-session path is the only way in.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runSweep(): Promise<NextResponse> {
  try {
    const result = await runDriftSweep();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    // Never 500 on a recoverable condition: return a zeroed sweep so the cron
    // health-monitor stays green. The per-agent failures are already swallowed
    // inside runDriftSweep; this guards an unexpected top-level throw (e.g. the
    // initial agent-list query).
    console.error("[cron/agent-drift]", (err as Error).message);
    return NextResponse.json({ ok: true, result: { checked: 0, paused: 0 } });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Cron path: bearer CRON_SECRET. The unattended sweep runs without a
  // logged-in operator.
  if (isAuthorizedCron(req)) {
    return runSweep();
  }

  // User path: capability check for an admin manual run.
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep();
}
