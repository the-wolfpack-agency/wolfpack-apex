/**
 * GET /api/cron/site-acceptance — judge the builds that are waiting.
 *
 * The deploy webhook queues a run the moment a deploy succeeds; this drains the
 * queue. Separating the two is the whole reason the check is reliable: the
 * comparison drives a real browser across several viewports, which is far longer
 * than the calling GitHub workflow will hold a webhook open, and a check that
 * gets abandoned halfway is exactly the "nobody actually looked" state this
 * layer exists to make impossible.
 *
 * Two auth paths, the same shape as the other cron endpoints in this repo:
 *   1. Cron: `Authorization: Bearer ${CRON_SECRET}`. Returns false when
 *      CRON_SECRET is unset (local dev) so the session path is the only way in.
 *   2. User: `requireCapability(req, "settings.manage_team")` for an operator
 *      draining the queue by hand.
 *
 * A failing build is NOT an error here. It is the signal, returned in the
 * summary with a 200, so the cron health monitor stays green and the actual
 * result is read from the payload rather than from an HTTP status.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { drainAcceptanceQueue } from "@/lib/site-acceptance/service";

export const dynamic = "force-dynamic";
/** Each run may start a browser and measure several viewports. */
export const maxDuration = 300;

/** How many runs one invocation drains. Small on purpose: the cron fires often,
 *  and a serverless instance that tries to hold many browsers at once runs out
 *  of memory and reports nothing at all. */
const BATCH = 3;

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
  }

  try {
    const result = await drainAcceptanceQueue(BATCH);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // A zeroed 200 keeps the cron monitor honest about reachability while the
    // payload says plainly that nothing was drained.
    return NextResponse.json({
      ok: false,
      claimed: 0,
      passed: 0,
      failed: 0,
      degraded: 0,
      runIds: [],
      error: err instanceof Error ? err.message : "drain failed",
    });
  }
}
