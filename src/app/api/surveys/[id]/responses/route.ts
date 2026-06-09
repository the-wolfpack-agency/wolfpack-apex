/**
 * /api/surveys/[id]/responses — results for a survey.
 *
 * GET (JSON, default) → { count, aggregate, responses }. aggregate reuses the
 * pure aggregateResponses so the rule never drifts from the responder.
 *
 * GET ?format=csv → text/csv with a header row of question labels and one
 * row per response (most-recent first). Multi-select answers are joined with
 * "; "; every field is CSV-escaped so a label or answer containing a comma,
 * quote, or newline can't break out of its cell.
 *
 * 401 if unauthed; 404 if the survey is missing.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getSurveyById, listResponses } from "@/lib/surveys/store";
import { aggregateResponses } from "@/lib/surveys/validate";
import type { AnswerValue, SurveyQuestion } from "@/lib/surveys/types";

/** RFC-4180-style escaping: wrap in quotes and double embedded quotes. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function answerToCell(q: SurveyQuestion, val: AnswerValue | undefined): string {
  if (val === undefined || val === null) return "";
  if (Array.isArray(val)) return val.join("; ");
  return String(val);
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const survey = await getSurveyById(id);
  if (!survey) return NextResponse.json({ error: "not found" }, { status: 404 });

  const responses = await listResponses(id);
  const url = new URL(req.url);

  if (url.searchParams.get("format") === "csv") {
    const questions = survey.schema.questions;
    const header = ["submitted_at", ...questions.map((q) => q.label)];
    const lines = [header.map(csvCell).join(",")];
    for (const r of responses) {
      const row = [
        r.submittedAt,
        ...questions.map((q) => answerToCell(q, r.answers[q.id])),
      ];
      lines.push(row.map((c) => csvCell(String(c))).join(","));
    }
    const csv = lines.join("\r\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="survey-${survey.slug}-responses.csv"`,
      },
    });
  }

  const aggregate = aggregateResponses(
    survey.schema,
    responses.map((r) => r.answers),
  );

  return NextResponse.json({
    count: responses.length,
    aggregate,
    responses,
  });
}
