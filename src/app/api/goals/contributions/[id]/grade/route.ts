/**
 * PATCH /api/goals/contributions/:id/grade — grade hit/miss/close.
 *
 * Body: { graded_as: "hit" | "miss" | "close" }
 *
 * Teammates grade their OWN commitments at the Friday sync. The grader
 * id is captured via the JWT (used for analytics + future audit).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { gradeContribution, type GradedAs } from "@/lib/goals-contributions";
import { trackEvent } from "@/lib/analytics";

const VALID_GRADES: GradedAs[] = ["hit", "miss", "close"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "contribution id required" }, { status: 400 });
  }

  let body: { graded_as?: unknown };
  try {
    body = (await req.json()) as { graded_as?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const grade = body.graded_as;
  if (typeof grade !== "string" || !VALID_GRADES.includes(grade as GradedAs)) {
    return NextResponse.json(
      { error: "graded_as must be one of hit|miss|close" },
      { status: 400 },
    );
  }

  const contribution = await gradeContribution(id, {
    graded_as: grade as GradedAs,
    graded_by_user_id: user.id,
  });
  if (!contribution) {
    return NextResponse.json({ error: "Contribution not found" }, { status: 404 });
  }

  trackEvent("goal.commitment_ui_graded", user.id, user.role, {
    contribution_id: contribution.id,
    result: contribution.graded_as ?? "unknown",
  });

  return NextResponse.json({ contribution });
}
