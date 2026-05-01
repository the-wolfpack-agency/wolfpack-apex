/**
 * GET  /api/programs/budgets — list budgets (drafts + active by default)
 * POST /api/programs/budgets — create a new cost budget header
 *
 * No role gate beyond authenticated — every team member can scope
 * their own programs. The CRUD writes emit `programBudget.*` analytics
 * events so the learning loop sees creation cadence + spec churn.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createBudget, listBudgets } from "@/lib/programs/budget-store";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status") as
    | "draft"
    | "active"
    | "closed"
    | "archived"
    | null;
  const budgets = await listBudgets({ status: status ?? undefined });
  return NextResponse.json({ budgets });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  try {
    const budget = await createBudget({
      name,
      jobNumber: typeof body.jobNumber === "string" ? body.jobNumber : null,
      version: typeof body.version === "string" ? body.version : "v1",
      clientId: typeof body.clientId === "string" ? body.clientId : null,
      contingencyPct:
        typeof body.contingencyPct === "number" ? body.contingencyPct : 0,
      notes: typeof body.notes === "string" ? body.notes : null,
      specs:
        body.specs && typeof body.specs === "object"
          ? (body.specs as Record<string, number>)
          : {},
      createdBy: user.id,
    });
    trackEvent("programBudget.created", user.id, user.role, {
      budget_id: budget.id,
      name: budget.name,
    });
    return NextResponse.json({ budget }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
