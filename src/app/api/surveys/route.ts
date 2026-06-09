/**
 * /api/surveys — list and create surveys.
 *
 * GET  → list surveys via the store; returns { surveys }. 401 if unauthed.
 * POST → create a draft survey from { title, description?, schema, clientId? }.
 *        Schema validation lives in the store (createSurvey THROWS the
 *        validation message); the route translates that throw into a 400 so
 *        a malformed/locked schema never returns 201. Emits survey.created
 *        analytics + an audit row, mirroring the QR create route.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { createSurvey, listSurveys } from "@/lib/surveys/store";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const mineOnly = url.searchParams.get("mine") === "true";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const surveys = await listSurveys({
    userId: mineOnly ? user.id : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({ surveys });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    title?: string;
    description?: string | null;
    schema?: unknown;
    clientId?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  let survey;
  try {
    survey = await createSurvey({
      title: body.title,
      description: body.description ?? null,
      // createSurvey re-validates the schema and throws on failure.
      schema: body.schema as never,
      clientId: body.clientId ?? null,
      userId: user.id,
      userRole: user.role,
    });
  } catch (err) {
    // Validation failures throw the human-readable message; surface as 400.
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  trackEvent("survey.created", user.id, user.role, {
    survey_id: survey.id,
    slug: survey.slug,
    question_count: survey.schema.questions.length,
    has_client: Boolean(survey.clientId),
  });
  void recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "survey.created",
    resourceType: "survey",
    resourceId: survey.id,
    afterState: {
      slug: survey.slug,
      title: survey.title,
      status: survey.status,
      questionCount: survey.schema.questions.length,
    },
  });

  return NextResponse.json({ survey }, { status: 201 });
}
