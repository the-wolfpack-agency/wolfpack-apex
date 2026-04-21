/**
 * POST /api/goals/contributions — create a manual commitment.
 *
 * Body: { kr_id, description, committed_for_week? (YYYY-MM-DD) }
 * user_id is ALWAYS taken from the JWT so users cannot post as someone
 * else. UI writes flow exclusively through this route — never directly
 * to the goals lib from client components.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  createManualContribution,
  getContributionsForKR,
} from "@/lib/goals-contributions";
import { trackEvent } from "@/lib/analytics";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/goals/contributions?kr_id=...&since=...&until=...
 *
 * Lists contributions for a single KR within an optional date window.
 * Used by the /goals page to render the last-7-days stream under each
 * expanded KR.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kr_id = req.nextUrl.searchParams.get("kr_id");
  if (!kr_id) {
    return NextResponse.json({ error: "kr_id is required" }, { status: 400 });
  }
  const since = req.nextUrl.searchParams.get("since") ?? undefined;
  const until = req.nextUrl.searchParams.get("until") ?? undefined;

  const contributions = await getContributionsForKR(kr_id, { since, until });
  return NextResponse.json({ contributions });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    kr_id?: string;
    description?: string;
    committed_for_week?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.kr_id || typeof body.kr_id !== "string") {
    return NextResponse.json({ error: "kr_id is required" }, { status: 400 });
  }
  if (
    !body.description ||
    typeof body.description !== "string" ||
    body.description.trim().length === 0
  ) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  if (
    body.committed_for_week != null &&
    (typeof body.committed_for_week !== "string" ||
      !DATE_RE.test(body.committed_for_week))
  ) {
    return NextResponse.json(
      { error: "committed_for_week must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const contribution = await createManualContribution({
    user_id: user.id,
    kr_id: body.kr_id,
    description: body.description.trim(),
    committed_for_week: body.committed_for_week ?? null,
  });

  trackEvent("goal.commitment_ui_submitted", user.id, user.role, {
    kr_id: contribution.kr_id,
    source: "manual",
  });

  return NextResponse.json({ contribution }, { status: 201 });
}
