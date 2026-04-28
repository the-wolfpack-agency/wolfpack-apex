/**
 * POST /api/support/tickets/[id]/auto-ack-diag
 *
 * Diagnostic-only: forces a retry of the auto-acknowledge pipeline for a
 * single ticket and returns the structured `{ acknowledged, reason }`
 * result so an operator can see exactly which gate (or Graph error)
 * blocked the auto-ack. The regular poller fires this fire-and-forget
 * with no return-value capture, so silent failures (gate_blocked, Graph
 * 4xx) leave no analytics trail.
 *
 * Idempotency: processAutoAcknowledge already short-circuits when the
 * ticket has `auto_acknowledged_at` set — re-hitting this route on a
 * ticket that already auto-acked returns `reason: "already_acknowledged"`
 * and does not double-send.
 *
 * Auth: cron-secret bearer OR `automations.run` capability — same dual
 * gate as /api/support/poll so we don't need a session cookie when
 * curling from the host machine during incident triage.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { processAutoAcknowledge } from "@/lib/support/auto-acknowledge";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedCron(req)) {
    const auth = await requireCapability(req, "automations.run");
    if (!auth.ok) return auth.response;
  }
  const { id } = await ctx.params;
  const result = await processAutoAcknowledge(id);
  return NextResponse.json({ ticket_id: id, ...result });
}
