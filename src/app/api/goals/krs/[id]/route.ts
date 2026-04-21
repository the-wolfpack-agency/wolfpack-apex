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
import { updateKRCurrent } from "@/lib/goals";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "kr id required" }, { status: 400 });

  let body: { current_value?: unknown };
  try {
    body = (await req.json()) as { current_value?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const value = body.current_value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return NextResponse.json(
      { error: "current_value must be a finite number" },
      { status: 400 },
    );
  }

  const kr = await updateKRCurrent(id, value, user.id);
  if (!kr) {
    return NextResponse.json({ error: "KR not found" }, { status: 404 });
  }
  return NextResponse.json({ kr });
}
