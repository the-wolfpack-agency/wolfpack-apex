/**
 * DELETE /api/goals/okrs/[id] — archive a company OKR (admin only).
 *
 * Archive = set status='archived'; the row stays for history + the KRs
 * remain queryable. Hard-delete is out of scope by design — we never
 * want the learning loop to lose a KR that had contributions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { archiveOKR, updateOKR } from "@/lib/goals";
import { trackEvent } from "@/lib/analytics";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const okr = await archiveOKR(id);
  if (!okr) {
    return NextResponse.json({ error: "okr_not_found" }, { status: 404 });
  }

  trackEvent("goal.okr_archived", user.id, user.role, { okr_id: id });

  return NextResponse.json({ okr });
}

/**
 * PATCH /api/goals/okrs/[id] — admin-only edit of objective / quarter.
 * Body: { objective?, quarter? }. No-op if both missing.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  let body: { objective?: unknown; quarter?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch: { objective?: string; quarter?: string } = {};
  if (typeof body.objective === "string") patch.objective = body.objective;
  if (typeof body.quarter === "string") patch.quarter = body.quarter;
  if (patch.quarter && !/^\d{4}-Q[1-4]$/.test(patch.quarter)) {
    return NextResponse.json({ error: "quarter must match YYYY-QN" }, { status: 400 });
  }

  const okr = await updateOKR(id, patch, user.id);
  if (!okr) return NextResponse.json({ error: "okr_not_found" }, { status: 404 });

  return NextResponse.json({ okr });
}
