/**
 * POST /api/principles/[id]/retire — soft-delete a principle.
 * Existing observations stay for scoreboard history. Reversible
 * only by inserting a new principle with the same slug.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { retirePrincipleNative } from "@/lib/principles/store";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  await retirePrincipleNative(id);
  trackEvent("principle.retired", user.id, user.role, { principle_id: id });
  return NextResponse.json({ ok: true });
}
