/**
 * GET    /api/programs/budgets/[id] — full read: header + lines + roll-up
 * PATCH  /api/programs/budgets/[id] — update header / specs / status
 * DELETE /api/programs/budgets/[id] — cascade delete
 *
 * The GET response is the single source of truth the dashboard renders
 * from. Bundling lines + rollup avoids three round-trips.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getBudget,
  updateBudget,
  deleteBudget,
  listLines,
  listBudgetCategories,
  getBudgetRollup,
  listActuals,
} from "@/lib/programs/budget-store";
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
  const [lines, categories, rollup, actuals] = await Promise.all([
    listLines(id),
    listBudgetCategories(),
    getBudgetRollup(id),
    listActuals(id),
  ]);
  trackEvent("programBudget.viewed", user.id, user.role, { budget_id: id });
  return NextResponse.json({ budget, lines, categories, rollup, actuals });
}

export async function PATCH(
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
  try {
    const budget = await updateBudget(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      jobNumber:
        body.jobNumber === null
          ? null
          : typeof body.jobNumber === "string"
            ? body.jobNumber
            : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      clientId:
        body.clientId === null
          ? null
          : typeof body.clientId === "string"
            ? body.clientId
            : undefined,
      contingencyPct:
        typeof body.contingencyPct === "number"
          ? body.contingencyPct
          : undefined,
      notes:
        body.notes === null
          ? null
          : typeof body.notes === "string"
            ? body.notes
            : undefined,
      status:
        typeof body.status === "string"
          ? (body.status as "draft" | "active" | "closed" | "archived")
          : undefined,
      specs:
        body.specs && typeof body.specs === "object"
          ? (body.specs as Record<string, number>)
          : undefined,
    });
    trackEvent("programBudget.updated", user.id, user.role, {
      budget_id: budget.id,
    });
    return NextResponse.json({ budget });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  await deleteBudget(id);
  trackEvent("programBudget.deleted", user.id, user.role, { budget_id: id });
  return NextResponse.json({ ok: true });
}
