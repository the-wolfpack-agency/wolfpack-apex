/**
 * PATCH /api/goals/krs/:id — update a KR's current_value.
 *
 * Body: { current_value: number }
 * Any authed teammate can update (no admin gate) — KR progress reads as
 * team-wide work. The U3 lib writes the signed delta into
 * `goal.kr_updated` analytics so the learning loop sees velocity.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { updateKRCurrent, updateKR, deleteKR } from "@/lib/goals";

function isAdmin(role: string): boolean {
  return role === "ceo" || role === "cto";
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "kr id required" }, { status: 400 });

  let body: {
    current_value?: unknown;
    metric?: unknown;
    target?: unknown;
    target_value?: unknown;
    unit?: unknown;
    cadence?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Admin-only KR definition edit: metric / target / unit / cadence.
  const wantsDefEdit =
    typeof body.metric === "string" ||
    typeof body.target === "number" ||
    typeof body.target_value === "number" ||
    body.unit !== undefined ||
    typeof body.cadence === "string";

  if (wantsDefEdit) {
    if (!isAdmin(user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const patch: {
      metric?: string;
      target?: number;
      unit?: string | null;
      cadence?: "daily" | "weekly" | "monthly" | "quarterly";
    } = {};
    if (typeof body.metric === "string") patch.metric = body.metric;
    const t = typeof body.target === "number" ? body.target : body.target_value;
    if (typeof t === "number" && Number.isFinite(t)) patch.target = t;
    if (body.unit === null) patch.unit = null;
    else if (typeof body.unit === "string") patch.unit = body.unit;
    if (
      body.cadence === "daily" ||
      body.cadence === "weekly" ||
      body.cadence === "monthly" ||
      body.cadence === "quarterly"
    ) {
      patch.cadence = body.cadence;
    }
    const kr = await updateKR(id, patch, user.id);
    if (!kr) return NextResponse.json({ error: "KR not found" }, { status: 404 });
    return NextResponse.json({ kr });
  }

  // Otherwise: anyone can move current_value forward.
  const value = body.current_value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return NextResponse.json(
      { error: "current_value must be a finite number" },
      { status: 400 },
    );
  }
  const kr = await updateKRCurrent(id, value, user.id);
  if (!kr) return NextResponse.json({ error: "KR not found" }, { status: 404 });
  return NextResponse.json({ kr });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "kr id required" }, { status: 400 });
  const row = await deleteKR(id, user.id);
  if (!row) return NextResponse.json({ error: "KR not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id: row.id });
}
