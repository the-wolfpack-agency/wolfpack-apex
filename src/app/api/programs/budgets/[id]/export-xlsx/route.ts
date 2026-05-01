/**
 * GET /api/programs/budgets/[id]/export-xlsx — render the canonical
 * budget back into the WPA template layout.
 *
 * Pre-computed totals + roll-up come from the DB so the file opens
 * with no formulas (and no Excel "this file is unsafe" prompts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getBudget,
  listLines,
  listBudgetCategories,
  getBudgetRollup,
} from "@/lib/programs/budget-store";
import {
  buildBudgetXlsx,
  type ExportLineRow,
  type ParsedBudgetSpecs,
} from "@/lib/programs/budget-xlsx";
import { trackEvent } from "@/lib/analytics";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const budget = await getBudget(id);
  if (!budget) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [lines, categories, rollup] = await Promise.all([
    listLines(id),
    listBudgetCategories(),
    getBudgetRollup(id),
  ]);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const exportLines: ExportLineRow[] = lines.map((l) => {
    const c = catById.get(l.categoryId);
    return {
      categoryName: c?.name || "Uncategorized",
      categoryKind: c?.kind || "fixed",
      costCode: l.costCode,
      responsible: l.responsibleUserId,
      lineNumber: l.lineNumber,
      description: l.description,
      name: l.name,
      units: l.units,
      rate: l.rate,
      total: l.total,
    };
  });
  const specs: ParsedBudgetSpecs = {
    jobName: budget.name,
    jobNumber: budget.jobNumber,
    version: budget.version,
    weeks: budget.weeks,
    prepEventDays: budget.prepEventDays,
    markets: budget.markets,
    eventDays: budget.eventDays,
    teams: budget.teams,
    hotel: budget.hotel,
    ballroom: budget.ballroom,
    breakoutRooms: budget.breakoutRooms,
    tents: budget.tents,
    clearSpanFrame: budget.clearSpanFrame,
    vehicles: budget.vehicles,
    staticDisplay: budget.staticDisplay,
    drive: budget.drive,
    competitors: budget.competitors,
  };
  const xlsx = await buildBudgetXlsx({
    jobName: budget.name,
    jobNumber: budget.jobNumber,
    version: budget.version,
    specs,
    fixedSubtotal: rollup.fixedSubtotal,
    variableSubtotal: rollup.variableSubtotal,
    contingencyAmount: rollup.contingencyAmount,
    grandTotal: rollup.plannedGrandTotal,
    lines: exportLines,
  });
  trackEvent("programBudget.xlsx_exported", user.id, user.role, {
    budget_id: id,
    line_count: lines.length,
  });
  return new NextResponse(xlsx as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${budget.name.replace(/[^a-z0-9_-]+/gi, "_")}-${budget.version}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
