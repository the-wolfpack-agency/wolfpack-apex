/**
 * POST /api/programs/budgets/[id]/lines — add a single detail line.
 *
 * Bulk create lives on the import-xlsx route; this endpoint is the
 * UI's "+ Add line" button.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createLine } from "@/lib/programs/budget-store";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  if (!categoryId) {
    return NextResponse.json({ error: "categoryId required" }, { status: 400 });
  }
  try {
    const line = await createLine({
      budgetId: id,
      categoryId,
      costCode:
        typeof body.costCode === "number" ? body.costCode : null,
      responsibleUserId:
        typeof body.responsibleUserId === "string"
          ? body.responsibleUserId
          : null,
      lineNumber:
        typeof body.lineNumber === "string" ? body.lineNumber : null,
      description:
        typeof body.description === "string" ? body.description : null,
      name: typeof body.name === "string" ? body.name : null,
      units: typeof body.units === "number" ? body.units : 0,
      rate: typeof body.rate === "number" ? body.rate : 0,
      notes: typeof body.notes === "string" ? body.notes : null,
      sortOrder:
        typeof body.sortOrder === "number" ? body.sortOrder : 0,
    });
    trackEvent("programBudget.line_added", user.id, user.role, {
      budget_id: id,
      line_id: line.id,
      category_id: categoryId,
      planned_total: line.total,
    });
    return NextResponse.json({ line }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
