/**
 * POST /api/automations/[automationId]/poll — kick the inbox poller.
 *
 * Auth: `automations.run` capability required.
 *
 * Returns a `PollResult` describing how many messages were seen,
 * matched, ingested vs. duplicate vs. quarantined, and how long the
 * tick took.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { pollInbox } from "@/lib/automations/inbox-poller";
import type { AutomationId } from "@/lib/automations/types";
import { getObsClient } from "@/lib/obs";

/**
 * Cron secret check. Vercel Cron Jobs hit the route as GET with
 * `Authorization: Bearer $CRON_SECRET`. We accept that as a stand-in
 * for capability auth so the unattended cron can run without a user
 * session. When the env var is unset (local dev) GET cron auth is
 * disabled and only the POST + capability path works.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runPoll(automationId: string, userId: string, userRole: string) {
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }
  const obs = getObsClient();
  const handle = obs.startSpan(`cron.automations.${automationId}.poll`, {
    automation_id: automationId,
    user_id: userId,
    user_role: userRole,
  });
  try {
    const result = await pollInbox({
      automationId: automation.id as AutomationId,
      userId,
      userRole,
    });
    const r = result as unknown as Record<string, unknown> | null | undefined;
    if (r && typeof r === "object") {
      const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
      handle.setAttribute("messages_seen", num("messages_seen") ?? null);
      handle.setAttribute("messages_matched", num("messages_matched") ?? null);
      handle.setAttribute("artifacts_ingested", num("artifacts_ingested") ?? null);
      handle.setAttribute("artifacts_duplicate", num("artifacts_duplicate") ?? null);
      handle.setAttribute("artifacts_quarantined", num("artifacts_quarantined") ?? null);
      handle.setAttribute("errors", num("errors") ?? null);
      handle.setAttribute("duration_ms", num("duration_ms") ?? null);
    }
    handle.end("ok");
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    /* "No valid Microsoft token" thrown by ms-graph clients downstream
       of pollInbox is the documented bootstrap state — the cron runs
       before any user has connected their mailbox. Translate to a 200
       with a structured skipped result so the health-monitor workflow
       treats it as a notice (not a failure). */
    const message = (err as Error).message ?? "";
    if (message.includes("No valid Microsoft token")) {
      handle.setAttribute("skipped", "no_user_connected");
      handle.end("ok");
      return NextResponse.json(
        {
          ok: true,
          result: {
            automation_id: automationId,
            messages_seen: 0,
            messages_matched: 0,
            artifacts_ingested: 0,
            artifacts_duplicate: 0,
            artifacts_quarantined: 0,
            errors: 0,
            duration_ms: 0,
            skipped: "no_user_connected",
            skipped_user_id: userId,
          },
        },
        { status: 200 },
      );
    }
    console.error("[automations/poll]", message);
    handle.setAttribute("error_message", message.slice(0, 300));
    handle.end("error");
    obs.recordError(err as Error, {
      route: `cron.automations.${automationId}.poll`,
      automation_id: automationId,
      user_id: userId,
    });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

/**
 * Operator-triggered poll (the "Run now" button on the dashboard).
 * Requires `automations.run` capability + a logged-in user — the
 * mailbox-owning email is taken from the user identity.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const { automationId } = await ctx.params;
  // Service-account path: GitHub Actions cron POSTs with the bearer
  // CRON_SECRET. Accept that as a stand-in for capability auth.
  if (isAuthorizedCron(req)) {
    const userId =
      process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";
    const userRole = process.env.AUTOMATION_POLL_USER_ROLE ?? "ops";
    return runPoll(automationId, userId, userRole);
  }
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;
  /* Pass the Instinct user.id — that's what ms_tokens.connected_by
     stores for the demo accounts (e.g. "demo-cto"). getValidToken's
     (connected_by OR user_email) lookup will match user_email for
     non-demo sessions. We deliberately do NOT prefer user.email
     because demo users have a placeholder email (cto@wolfpack.dev)
     that does not match any real Microsoft mailbox; the id is the
     stable anchor. */
  return runPoll(automationId, auth.user.id, auth.user.role);
}

/**
 * Cron-triggered poll (Vercel Cron Jobs hit GET with the bearer
 * CRON_SECRET). The userId is taken from `AUTOMATION_POLL_USER_ID` —
 * a service-account identity owned by ops. We do NOT default to the
 * automation's `owner_label` because that's a display label, not a
 * stable id.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  if (!isAuthorizedCron(req)) {
    // Fall back to the user-session path so a logged-in operator can
    // also invoke via GET from the browser if they prefer.
    const auth = await requireCapability(req, "automations.run");
    if (!auth.ok) return auth.response;
    const { automationId } = await ctx.params;
    return runPoll(automationId, auth.user.id, auth.user.role);
  }
  const userId =
    process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";
  const userRole = process.env.AUTOMATION_POLL_USER_ROLE ?? "ops";
  const { automationId } = await ctx.params;
  return runPoll(automationId, userId, userRole);
}
