/**
 * POST /api/programs/budgets/[id]/actuals — record an actual against a
 * specific line.
 *
 * Source can be `manual`, `qb_bill`, `qb_invoice`, `expense`, or
 * `receipt`. `evidence` carries provenance (QB invoice id, receipt
 * url, signer, etc.) so the audit trail is queryable later.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createActual } from "@/lib/programs/budget-store";
import { trackEvent } from "@/lib/analytics";

const VALID_SOURCES = new Set([
  "manual",
  "qb_bill",
  "qb_invoice",
  "expense",
  "receipt",
]);

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
  const lineId = typeof body.lineId === "string" ? body.lineId : "";
  if (!lineId) return NextResponse.json({ error: "lineId required" }, { status: 400 });
  const source = typeof body.source === "string" ? body.source : "";
  if (!VALID_SOURCES.has(source)) {
    return NextResponse.json({ error: "invalid source" }, { status: 400 });
  }
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount)) {
    return NextResponse.json({ error: "amount required" }, { status: 400 });
  }
  try {
    const actual = await createActual({
      lineId,
      source: source as "manual" | "qb_bill" | "qb_invoice" | "expense" | "receipt",
      sourceId: typeof body.sourceId === "string" ? body.sourceId : null,
      vendor: typeof body.vendor === "string" ? body.vendor : null,
      amount: body.amount,
      currency: typeof body.currency === "string" ? body.currency : "USD",
      occurredAt:
        typeof body.occurredAt === "string" ? body.occurredAt : undefined,
      evidence:
        body.evidence && typeof body.evidence === "object"
          ? (body.evidence as Record<string, unknown>)
          : {},
    });
    trackEvent("programBudget.actual_recorded", user.id, user.role, {
      budget_id: id,
      line_id: lineId,
      source: actual.source,
      amount: actual.amount,
    });
    return NextResponse.json({ actual }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
