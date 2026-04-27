/**
 * GET /api/support/poll — kick the support inbox poller.
 *
 * Two auth paths:
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}` is provided.
 *      We use AUTOMATION_POLL_USER_ID (default 'automation-cron') as
 *      the identity for getValidToken / analytics. This is how Vercel
 *      Cron Jobs (and GitHub Actions cron) will hit the route on a
 *      schedule.
 *   2. User path: `requireCapability(req, 'automations.run')` — a
 *      logged-in operator hitting "Run now" from the /support page.
 *
 * The route NEVER 500s on a recoverable precondition (missing token,
 * Graph 401/403). Instead the underlying poller returns a structured
 * `skipped` result which we forward as a 200 — keeps the cron
 * health-monitor green. Hard infrastructure errors (DB down,
 * unexpected throw) bubble up as 500.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getObsClient } from "@/lib/obs";
import { pollSupportInbox } from "@/lib/support/inbox-poller";

/**
 * Cron secret check. Mirrors the pattern in
 * `src/app/api/automations/[automationId]/poll/route.ts` so all our
 * cron-triggered endpoints share one mental model. Returns false when
 * CRON_SECRET is unset (local dev) so the user-session path is the
 * only way in.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runPoll(userId: string, userRole: string) {
  const obs = getObsClient();
  const handle = obs.startSpan("cron.support.poll", {
    user_id: userId,
    user_role: userRole,
  });
  try {
    const result = await pollSupportInbox({ userId, userRole });
    /* Mirror the PollResult shape onto the span so traces line up
       with analytics events without re-deriving the numbers. */
    const r = result as unknown as Record<string, unknown> | null | undefined;
    if (r && typeof r === "object") {
      const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
      handle.setAttribute("messages_seen", num("messages_seen") ?? null);
      handle.setAttribute("tickets_created", num("tickets_created") ?? null);
      handle.setAttribute("replies_appended", num("replies_appended") ?? null);
      handle.setAttribute("errors", num("errors") ?? null);
      handle.setAttribute("duration_ms", num("duration_ms") ?? null);
    }
    handle.end("ok");
    /* trackEvent is also fired inside pollSupportInbox on the happy +
       skipped paths so the route layer doesn't double-emit. We only
       emit here on hard error below. */
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = (err as Error).message ?? "unknown";
    console.error("[support/poll]", message);
    handle.setAttribute("error_message", message.slice(0, 300));
    handle.end("error");
    obs.recordError(err as Error, {
      route: "cron.support.poll",
      user_id: userId,
    });
    try {
      trackEvent("support.poll_run", userId, userRole, {
        source: "support-inbox",
        errors: 1,
        error_detail: message.slice(0, 300),
      });
    } catch {
      /* analytics best-effort */
    }
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  // Cron path: bearer CRON_SECRET. Service-account identity stands in
  // for capability auth so the unattended cron can run without a
  // logged-in operator.
  if (isAuthorizedCron(req)) {
    const userId = process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";
    const userRole = process.env.AUTOMATION_POLL_USER_ROLE ?? "ops";
    return runPoll(userId, userRole);
  }

  // User path: capability check + operator identity.
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;
  return runPoll(auth.user.id, auth.user.role);
}
