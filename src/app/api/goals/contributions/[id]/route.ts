/**
 * DELETE /api/goals/contributions/[id] — admin-only hard delete.
 * PATCH  /api/goals/contributions/[id] — admin-only description edit.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  deleteContribution,
  updateContributionDescription,
} from "@/lib/goals-contributions";
import { trackEvent } from "@/lib/analytics";

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

  const row = await deleteContribution(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  trackEvent("goal.contribution_deleted", user.id, user.role, { contribution_id: id });
  return NextResponse.json({ ok: true, id: row.id });
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

  let body: { description?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.description !== "string" || body.description.trim().length === 0) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }

  const row = await updateContributionDescription(id, body.description);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  trackEvent("goal.contribution_edited", user.id, user.role, { contribution_id: id });
  return NextResponse.json({ contribution: row });
}
