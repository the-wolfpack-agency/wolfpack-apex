/**
 * GET /api/automations/[automationId]/changes — Mon/Fri-style digest.
 *
 * Returns one row per class_key whose class_date falls inside the
 * automation's `active_window_days`, with the LATEST delta_added /
 * delta_dropped / net_change. The UI renders this as the "what changed
 * since last sync" view.
 *
 * Auth: `automations.view` capability required.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { getChangeDigest } from "@/lib/automations/queries";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }

  const digest = await getChangeDigest({
    automationId: automation.id,
    windowMinDays: automation.active_window_days.min,
    windowMaxDays: automation.active_window_days.max,
  });

  return NextResponse.json({
    window: automation.active_window_days,
    classes: digest,
  });
}
