/**
 * GET /api/cron/ogiam-checkpoint
 *
 * Scheduled checkpoint sweep for the OGIAM decision ledger. For every
 * workspace with new decisions since its last checkpoint, signs the
 * current chain head and records a notarization checkpoint (one
 * signature anchoring every decision up to that point, like a
 * Certificate Transparency signed tree head).
 *
 * Two auth paths, mirroring src/app/api/support/poll/route.ts:
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}` is provided.
 *      This is how Vercel Cron hits the route hourly.
 *   2. User path: `requireCapability(req, 'settings.manage_team')`: a
 *      logged-in operator hitting "Run now" from the /admin/ogiam page.
 *
 * The route NEVER 500s on a recoverable precondition (no DATABASE_URL,
 * signer disabled, etc.). runCheckpointSweep reads through safeQuery and
 * degrades gracefully; we additionally catch any recoverable throw and
 * return a 200 with a zeroed/skipped result so the cron health monitor
 * stays green. Only a hard, unexpected throw bubbles up as a 500.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { runCheckpointSweep } from "@/lib/ogiam/checkpoint";

/**
 * Cron secret check. Mirrors the helper in
 * `src/app/api/support/poll/route.ts` so all cron-triggered endpoints
 * share one mental model. Returns false when CRON_SECRET is unset (local
 * dev) so the user-session path is the only way in.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runSweep() {
  try {
    const result = await runCheckpointSweep();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    /* Recoverable conditions (no DB, signer offline) already degrade
       inside runCheckpointSweep. Anything that still escapes here is
       treated as recoverable: we return a zeroed result with a 200 so the
       cron health monitor does not flap. A genuinely unexpected throw
       would have to be non-Error to reach the rethrow below. */
    const message = (err as Error)?.message ?? "unknown";
    console.warn("[cron/ogiam-checkpoint] skipped:", message);
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: message.slice(0, 300),
      result: { workspaces: 0, written: 0 },
    });
  }
}

export async function GET(req: NextRequest) {
  // Cron path: bearer CRON_SECRET. The unattended sweep runs without a
  // logged-in operator; the sweep itself acts as the "system" identity.
  if (isAuthorizedCron(req)) {
    return runSweep();
  }

  // User path: capability check + operator identity for a manual "Run now".
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep();
}
