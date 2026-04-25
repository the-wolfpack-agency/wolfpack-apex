/**
 * GET /api/automations/[automationId] — automation overview.
 *
 * Returns:
 *   - automation metadata (id, name, owner_label, description, window)
 *   - counts: artifacts_today, open_exceptions, classes_in_window
 *
 * Auth: `automations.view` capability required.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { getAutomationCounts } from "@/lib/automations/queries";
import type { AutomationId } from "@/lib/automations/types";

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

  const counts = await getAutomationCounts({
    automationId: automation.id,
    windowMinDays: automation.active_window_days.min,
    windowMaxDays: automation.active_window_days.max,
  });

  return NextResponse.json({
    automation: {
      id: automation.id,
      name: automation.name,
      owner_label: automation.owner_label,
      description: automation.description,
      active_window_days: automation.active_window_days,
      source_types: Object.keys(automation.parsers),
      has_summary_assembler: typeof automation.assemble_summary === "function",
    },
    counts,
  });
}

// Concrete export so `import type { AutomationId } from ...` doesn't get
// pruned by ts-jest in the route test.
export type AutomationIdAlias = AutomationId;
