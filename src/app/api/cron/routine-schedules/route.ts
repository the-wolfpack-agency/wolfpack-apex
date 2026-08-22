/**
 * GET /api/cron/routine-schedules: run the routines that are due.
 *
 * Every fifteen minutes. A schedule is a promise about somebody's morning, and
 * an hourly sweep would deliver an eight o'clock briefing at half past.
 *
 * Two auth paths, mirroring the other cron routes here:
 *   1. Cron: Authorization: Bearer ${CRON_SECRET}. Returns false when the
 *      secret is unset, so a local dev server cannot be swept by accident.
 *   2. Person: requireCapability(req, "settings.manage_team") for an admin
 *      forcing a pass while looking into something.
 *
 * NEVER 500s ON A RECOVERABLE CONDITION. A sweep is best effort, and a
 * top-level throw would take the cron health monitor red for something that
 * amounts to one person's routine having a bad morning.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { sweepDueRoutines } from "@/lib/assistant/routines/sweep";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function runSweep(actorId: string, actorRole: string): Promise<NextResponse> {
  try {
    const result = await sweepDueRoutines();
    trackEvent("assistant.routine_sweep", actorId, actorRole, {
      due: result.due,
      ran: result.ran,
      /* Counted apart: a sweep where everything is WAITING is the system
         working exactly as designed, and one where everything FAILED looks
         identical in a single "ran" number. */
      waiting: result.waiting,
      failed: result.failed,
      deactivated: result.deactivated,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/routine-schedules]", (err as Error).message);
    return NextResponse.json({ ok: true, due: 0, ran: 0, waiting: 0, failed: 0, deactivated: 0 });
  }
}

export async function GET(req: NextRequest) {
  if (isAuthorizedCron(req)) return runSweep("system", "system");
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep(auth.user.id, auth.user.role);
}
