/**
 * /api/surveys/[id]/qr — mint a QR code that points at this survey's public
 * responder (/s/<slug>) and link it back onto the survey.
 *
 * POST → look up the survey (404 if missing); build the absolute target from
 * the request origin; createCode(); persist the new code id via
 * updateSurvey({ qrCodeId }); emit survey.qr_linked + an audit row; return
 * { code, survey }. 401 if unauthed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { createCode } from "@/lib/qr/codes";
import { getSurveyById, updateSurvey } from "@/lib/surveys/store";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const survey = await getSurveyById(id);
  if (!survey) return NextResponse.json({ error: "not found" }, { status: 404 });

  const origin = new URL(req.url).origin;
  const targetUrl = `${origin}/s/${survey.slug}`;

  let code;
  try {
    code = await createCode({
      targetUrl,
      label: survey.title,
      userId: user.id,
      userRole: user.role,
    });
  } catch (err) {
    console.error("[api/surveys/qr] createCode failed:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to create QR code" },
      { status: 500 },
    );
  }

  const updated = await updateSurvey(id, { qrCodeId: code.id });

  trackEvent("survey.qr_linked", user.id, user.role, {
    survey_id: id,
    slug: survey.slug,
    qr_code_id: code.id,
    qr_slug: code.slug,
  });
  void recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "survey.qr_linked",
    resourceType: "survey",
    resourceId: id,
    afterState: { slug: survey.slug, qrCodeId: code.id, qrSlug: code.slug },
  });

  return NextResponse.json({ code, survey: updated });
}
