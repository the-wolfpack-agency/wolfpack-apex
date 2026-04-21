/**
 * DELETE /api/goals/okrs/[id] — archive a company OKR (admin only).
 *
 * Archive = set status='archived'; the row stays for history + the KRs
 * remain queryable. Hard-delete is out of scope by design — we never
 * want the learning loop to lose a KR that had contributions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { archiveOKR } from "@/lib/goals";
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
