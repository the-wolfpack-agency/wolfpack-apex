/**
 * /api/surveys/[id]/insights — funnel + completion analytics for a survey.
 *
 * GET (JSON) → { insights }. The insights object is the view→completion
 * funnel a form SaaS doesn't surface: views, responses, completion rate,
 * average time-to-complete, attribution (device / country / referrer), and
 * the per-question aggregate. The math lives in the pure computeInsights so
 * the rule never drifts from the responder/aggregator; this route only
 * fetches the inputs and serializes.
 *
 * Auth mirrors the sibling /responses route: 401 if unauthed, 404 if the
 * survey is missing.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getSurveyById,
  countSurveyViews,
  listResponses,
} from "@/lib/surveys/store";
import { computeInsights } from "@/lib/surveys/insights";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const survey = await getSurveyById(id);
  if (!survey) return NextResponse.json({ error: "not found" }, { status: 404 });

  const views = await countSurveyViews(id);
  const responses = await listResponses(id);

  return NextResponse.json({
    insights: computeInsights(survey.schema, views, responses),
  });
}
