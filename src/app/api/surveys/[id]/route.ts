/**
 * /api/surveys/[id] — single-survey GET / PATCH / DELETE.
 *
 * PATCH carries any of { title, description, schema, status }. Schema/title
 * validation lives in the store (updateSurvey THROWS) → 400. A status
 * transition picks the right analytics event: published→survey.published,
 * closed→survey.closed, otherwise survey.updated. Every mutation writes an
 * audit row so audit-coverage passes.
 *
 * params is a Promise (Next 16 App Router), matching the QR [id] route.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import {
  getSurveyById,
  updateSurvey,
  deleteSurvey,
} from "@/lib/surveys/store";
import type { InstinctEventType } from "@/lib/analytics";
import type { SurveyStatus } from "@/lib/surveys/types";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const survey = await getSurveyById(id);
  if (!survey) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ survey });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  let body: {
    title?: string;
    description?: string | null;
    schema?: unknown;
    status?: SurveyStatus;
    slug?: string;
    theme?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const existing = await getSurveyById(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  /* Build the patch only from fields the caller actually sent so we never
     null-out a column they didn't touch. */
  const patch: Parameters<typeof updateSurvey>[1] = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.schema !== undefined) patch.schema = body.schema as never;
  if (body.status !== undefined) patch.status = body.status;
  if (body.slug !== undefined) patch.slug = body.slug;
  if (body.theme !== undefined) patch.theme = body.theme;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "patch is empty" }, { status: 400 });
  }

  let survey;
  try {
    survey = await updateSurvey(id, patch);
  } catch (err) {
    const msg = (err as Error).message;
    // A taken vanity slug is a conflict, not a malformed request.
    if (msg === "slug_taken") {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  /* Status transitions get their own event; everything else is an update. */
  let event: InstinctEventType = "survey.updated";
  if (patch.status === "published" && existing.status !== "published") {
    event = "survey.published";
  } else if (patch.status === "closed" && existing.status !== "closed") {
    event = "survey.closed";
  }

  trackEvent(event, user.id, user.role, {
    survey_id: survey.id,
    slug: survey.slug,
    status: survey.status,
  });
  void recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: event,
    resourceType: "survey",
    resourceId: survey.id,
    beforeState: { title: existing.title, status: existing.status },
    afterState: { title: survey.title, status: survey.status },
  });

  return NextResponse.json({ survey });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const existing = await getSurveyById(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await deleteSurvey(id);

  trackEvent("survey.deleted", user.id, user.role, {
    survey_id: id,
    slug: existing.slug,
  });
  void recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "survey.deleted",
    resourceType: "survey",
    resourceId: id,
    beforeState: {
      slug: existing.slug,
      title: existing.title,
      status: existing.status,
    },
  });

  return NextResponse.json({ ok: true });
}
