/**
 * POST /api/goals/okrs/[id]/krs — append a KR to an existing OKR.
 *
 * Any authenticated teammate can supplement an active OKR (not just
 * admins) — this is the "team member adds a KR under the company
 * objective" path. Archived OKRs are locked.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { addKRToOKR, type KRInput } from "@/lib/goals";

interface KrBody {
  metric?: string;
  target?: number;
  target_value?: number;
  unit?: string | null;
  cadence?: KRInput["cadence"];
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  let body: KrBody;
  try {
    body = (await req.json()) as KrBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.metric || typeof body.metric !== "string" || body.metric.trim().length === 0) {
    return NextResponse.json({ error: "metric is required" }, { status: 400 });
  }
  const target = typeof body.target === "number" ? body.target : body.target_value;
  if (typeof target !== "number" || !Number.isFinite(target)) {
    return NextResponse.json(
      { error: "target (or target_value) must be a finite number" },
      { status: 400 },
    );
  }

  const kr = await addKRToOKR(
    id,
    {
      metric: body.metric.trim(),
      target,
      unit: body.unit ?? null,
      cadence: body.cadence,
    },
    user.id,
  );

  if (!kr) {
    return NextResponse.json({ error: "okr_not_found_or_archived" }, { status: 404 });
  }

  return NextResponse.json({ kr }, { status: 201 });
}
