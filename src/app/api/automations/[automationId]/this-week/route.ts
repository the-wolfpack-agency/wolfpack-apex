/**
 * /api/automations/[automationId]/this-week
 *
 * GET → one row per active class in the registry's `active_window_days`
 * range, with traffic-light status + sources-present/missing + last
 * activity + open-exception count + most-recent-SharePoint-upload
 * timestamp.
 *
 * Powers `/automations/porsche-classes` — the "this week" dashboard
 * that replaces the old summaries-list index for porsche-classes
 * specifically. The route remains config-driven (any registered
 * automation can be queried) so meeting-insights can adopt the same
 * surface in a follow-up without re-implementing the projection.
 *
 * Auth: `automations.view` (HR / Ops / Dev / CEO / CTO have it by
 * default — same roster as the other automation read routes).
 *
 * Failure shape:
 *   401 { error: "unauthorized" }
 *   403 { error: "forbidden" }
 *   404 { error: "automation not found" } — unknown id
 *   500 { error, reason: "aggregator_error" } — DB blew up
 *   200 { window, classes }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { listThisWeekClasses } from "@/lib/automations/porsche-classes/this-week-aggregator";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found", automationId },
      { status: 404 },
    );
  }

  let classes;
  try {
    classes = await listThisWeekClasses({
      automationId: automation.id,
      windowMinDays: automation.active_window_days.min,
      windowMaxDays: automation.active_window_days.max,
    });
  } catch (err) {
    console.error(
      `[automations/${automationId}/this-week] aggregator threw:`,
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "this-week aggregation failed", reason: "aggregator_error" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    window: automation.active_window_days,
    classes,
  });
}
