/**
 * POST /api/goals/okrs — Create a new OKR (admin only).
 *
 * Admin = role ∈ {ceo, cto}. Hard-gated because a misfired OKR drift is
 * noisy for the whole team.
 *
 * Accepts BOTH body shapes to match U3's `krs: [{ metric, target, unit?,
 * cadence? }]` plus the task-spec-friendly `key_results: [{ metric,
 * target_value, … }]` alias so the UI / test fixtures can use whichever
 * is natural. Normalizes to U3's contract before calling createOKR().
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createOKR, type KRInput } from "@/lib/goals";
import { trackEvent } from "@/lib/analytics";
import { fanoutToTeam, actorLabel } from "@/lib/notifications/team-fanout";

const QUARTER_RE = /^[0-9]{4}-Q[1-4]$/;

interface KrPayload {
  metric?: string;
  target?: number;
  target_value?: number;
  unit?: string | null;
  cadence?: KRInput["cadence"];
  display_order?: number;
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    quarter?: string;
    objective?: string;
    krs?: KrPayload[];
    key_results?: KrPayload[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.quarter || !QUARTER_RE.test(body.quarter)) {
    return NextResponse.json(
      { error: "quarter must match YYYY-QN" },
      { status: 400 },
    );
  }
  if (
    !body.objective ||
    typeof body.objective !== "string" ||
    body.objective.trim().length === 0
  ) {
    return NextResponse.json({ error: "objective is required" }, { status: 400 });
  }

  const rawKrs = body.krs ?? body.key_results;
  if (!Array.isArray(rawKrs) || rawKrs.length === 0) {
    return NextResponse.json(
      { error: "krs must be a non-empty array" },
      { status: 400 },
    );
  }

  const normalized: KRInput[] = [];
  for (const kr of rawKrs) {
    if (!kr.metric || typeof kr.metric !== "string") {
      return NextResponse.json({ error: "kr.metric is required" }, { status: 400 });
    }
    const target = typeof kr.target === "number" ? kr.target : kr.target_value;
    if (typeof target !== "number" || !Number.isFinite(target)) {
      return NextResponse.json(
        { error: "kr.target (or target_value) must be a finite number" },
        { status: 400 },
      );
    }
    normalized.push({
      metric: kr.metric,
      target,
      unit: kr.unit ?? null,
      cadence: kr.cadence,
    });
  }

  const okr = await createOKR({
    quarter: body.quarter,
    objective: body.objective.trim(),
    krs: normalized,
    created_by_user_id: user.id,
  });

  trackEvent("goal.okr_created_ui", user.id, user.role, {
    quarter: okr.quarter,
    kr_count: okr.krs.length,
  });

  await fanoutToTeam({
    actor: user,
    title: `New OKR: ${okr.objective}`,
    body: `${actorLabel(user)} (${user.role.toUpperCase()}) added a new OKR for ${okr.quarter}: ${okr.objective}`,
    actionUrl: "/goals",
    actionLabel: "View goals",
    category: "goals",
    source: "instinct.goals",
    sourceId: okr.id,
    metadata: { goal_type: "okr", action: "created", okr_id: okr.id },
    analyticsEvent: "goals.team_notified",
    analyticsPayload: { goal_type: "okr", action: "created", okr_id: okr.id },
    excludeActor: true,
  });

  return NextResponse.json({ okr }, { status: 201 });
}
