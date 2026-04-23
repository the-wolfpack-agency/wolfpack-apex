/**
 * DELETE /api/goals/north-star/[id] — admin-only.
 * PATCH  /api/goals/north-star/[id] — admin-only edit of value/label/unit.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { deleteNorthStar, updateNorthStar } from "@/lib/goals-north-star";
import { trackEvent } from "@/lib/analytics";
import { fanoutToTeam, actorLabel } from "@/lib/notifications/team-fanout";

function isAdmin(role: string): boolean {
  return role === "ceo" || role === "cto";
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const snap = await deleteNorthStar(id);
  if (!snap) return NextResponse.json({ error: "not_found" }, { status: 404 });

  trackEvent("goal.north_star_deleted", user.id, user.role, { snapshot_id: id });
  return NextResponse.json({ snapshot: snap });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  let body: { value?: unknown; label?: unknown; unit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch: { value?: number; label?: string; unit?: string | null } = {};
  if (typeof body.value === "number" && Number.isFinite(body.value)) patch.value = body.value;
  if (typeof body.label === "string") patch.label = body.label;
  if (body.unit === null || typeof body.unit === "string") patch.unit = body.unit as string | null;

  const snap = await updateNorthStar(id, patch);
  if (!snap) return NextResponse.json({ error: "not_found" }, { status: 404 });

  trackEvent("goal.north_star_edited", user.id, user.role, { snapshot_id: id });

  await fanoutToTeam({
    actor: user,
    title: `North star updated: ${snap.label}`,
    body: `${actorLabel(user)} (${user.role.toUpperCase()}) edited the north-star entry for ${snap.label}`,
    actionUrl: "/goals",
    actionLabel: "View goals",
    category: "goals",
    source: "instinct.goals.north_star",
    sourceId: id,
    metadata: { goal_type: "north_star", action: "updated", snapshot_id: id },
    analyticsEvent: "goals.team_notified",
    analyticsPayload: { goal_type: "north_star", action: "updated", snapshot_id: id },
    excludeActor: true,
  });

  return NextResponse.json({ snapshot: snap });
}
