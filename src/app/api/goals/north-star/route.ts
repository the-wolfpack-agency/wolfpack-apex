/**
 * POST /api/goals/north-star — capture a north-star snapshot.
 *
 * Body: { value: number, label: string, unit?: string }
 *
 * Admin-gated (ceo|cto) to keep the series clean — sharing a single
 * label series across the team means anyone could otherwise emit noise
 * into the dashboard's sparkline.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { captureNorthStar } from "@/lib/goals-north-star";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { value?: unknown; label?: unknown; unit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
    return NextResponse.json(
      { error: "value must be a finite number" },
      { status: 400 },
    );
  }
  if (typeof body.label !== "string" || body.label.trim().length === 0) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  const unit =
    typeof body.unit === "string" && body.unit.trim().length > 0
      ? body.unit.trim()
      : null;

  const snapshot = await captureNorthStar({
    value: body.value,
    label: body.label.trim(),
    unit,
  });

  trackEvent("goal.north_star_ui_updated", user.id, user.role, {
    label: snapshot.label,
  });

  return NextResponse.json({ snapshot }, { status: 201 });
}
