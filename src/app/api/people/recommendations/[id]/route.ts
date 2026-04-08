/**
 * /api/people/recommendations/[id] — accept or reject a recommendation.
 *
 * PATCH body: { outcome: "accepted" | "rejected" | "ignored" }
 *
 * The brain uses outcome history to learn which scoring rules produce
 * recommendations that get accepted vs ignored.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { decideRecommendation } from "@/lib/benefits";

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  const outcome = body.outcome as "accepted" | "rejected" | "ignored" | undefined;
  if (!outcome || !["accepted", "rejected", "ignored"].includes(outcome)) {
    return NextResponse.json({ error: "outcome must be accepted|rejected|ignored" }, { status: 400 });
  }
  await decideRecommendation(id, outcome, user.id, user.role);
  return NextResponse.json({ ok: true });
}
