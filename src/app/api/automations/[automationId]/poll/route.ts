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
  try {
    const result = await pollInbox({
      automationId: automation.id as AutomationId,
      userId,
      userRole,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[automations/poll]", (err as Error).message);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
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
     stores. getValidToken's (connected_by OR user_email) dual lookup
     also handles the email-anchored case for backwards compat. */
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
    return runPoll(automationId, auth.user.email ?? auth.user.id, auth.user.role);
  }
  const userId =
    process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";
  const userRole = process.env.AUTOMATION_POLL_USER_ROLE ?? "ops";
  const { automationId } = await ctx.params;
  return runPoll(automationId, userId, userRole);
}
