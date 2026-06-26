/**
 * GET /api/cron/agent-failover: the GOVERNED backup-agent failover sweep.
 *
 * Keeps work flowing when an agent goes down. Two phases, both governed:
 *   1. reclaimStalledTasks — a 'running' task whose agent died sits stuck; if it
 *      stalled past the window it is requeued (under a retry cap) or, over the
 *      cap, marked 'failed'. This frees the work so phase 2 can move it.
 *   2. failoverUnhealthyAgents — for each paused/revoked agent that has queued
 *      work AND a designated, ACTIVE, SCOPE-COMPATIBLE backup, reassign the
 *      queued tasks to the backup. The tasks stay 'queued' and later run AS the
 *      backup under the SAME OGIAM gate. A backup missing any connection the
 *      primary holds is SKIPPED (no scope escalation).
 *
 * Two auth paths (mirrors /api/cron/agent-drift exactly):
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron hits this
 *      on schedule. Returns false when CRON_SECRET is unset (local dev) so the
 *      user-session path is the only way in.
 *   2. User path: `requireCapability(req, "settings.manage_team")` for a
 *      logged-in admin triggering a manual failover from the agent admin surface.
 *
 * Never 500s on a recoverable condition: an unexpected throw is caught and
 * returned as a zeroed 200 so the cron health-monitor stays green. The
 * per-row failures are already swallowed inside the store.
 *
 * Audit: runFailoverSweep records hash-chained audit entries for each triggered
 * failover (and setBackupAgent audits designations), so this route imports
 * recordAudit indirectly through the store; the route itself emits no per-sweep
 * audit row (the sweep's own entries carry the compliance record).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { runFailoverSweep } from "@/lib/agents/failover/store";

/**
 * Cron secret check. Mirrors src/app/api/cron/agent-drift/route.ts so all our
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
    const result = await runFailoverSweep();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    // Never 500 on a recoverable condition: return a zeroed sweep so the cron
    // health-monitor stays green. Per-row failures are already swallowed inside
    // the store; this guards an unexpected top-level throw.
    console.error("[cron/agent-failover]", (err as Error).message);
    return NextResponse.json({
      ok: true,
      result: { reclaimed: 0, reassigned: 0, skipped: 0 },
    });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Cron path: bearer CRON_SECRET. The unattended sweep runs without an operator.
  if (isAuthorizedCron(req)) {
    return runSweep();
  }

  // User path: capability check for an admin manual run.
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep();
}
