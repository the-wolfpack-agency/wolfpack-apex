/**
 * PATCH  /api/programs/budgets/[id]/lines/[lineId] — edit one detail line.
 * DELETE /api/programs/budgets/[id]/lines/[lineId] — drop one detail line.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { updateLine, deleteLine } from "@/lib/programs/budget-store";
import { trackEvent } from "@/lib/analytics";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; lineId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, lineId } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const line = await updateLine(lineId, {
      categoryId:
        typeof body.categoryId === "string" ? body.categoryId : undefined,
      costCode:
        body.costCode === null
          ? null
          : typeof body.costCode === "number"
            ? body.costCode
            : undefined,
      responsibleUserId:
        body.responsibleUserId === null
          ? null
          : typeof body.responsibleUserId === "string"
            ? body.responsibleUserId
            : undefined,
      lineNumber:
        body.lineNumber === null
          ? null
          : typeof body.lineNumber === "string"
            ? body.lineNumber
            : undefined,
      description:
        body.description === null
          ? null
          : typeof body.description === "string"
            ? body.description
            : undefined,
      name:
        body.name === null
          ? null
          : typeof body.name === "string"
            ? body.name
            : undefined,
      units: typeof body.units === "number" ? body.units : undefined,
      rate: typeof body.rate === "number" ? body.rate : undefined,
      notes:
        body.notes === null
          ? null
          : typeof body.notes === "string"
            ? body.notes
            : undefined,
      sortOrder:
        typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    });
    trackEvent("programBudget.line_updated", user.id, user.role, {
      budget_id: id,
      line_id: line.id,
      planned_total: line.total,
    });
    return NextResponse.json({ line });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string; lineId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, lineId } = await context.params;
  await deleteLine(lineId);
  trackEvent("programBudget.line_deleted", user.id, user.role, {
    budget_id: id,
    line_id: lineId,
  });
  return NextResponse.json({ ok: true });
}
