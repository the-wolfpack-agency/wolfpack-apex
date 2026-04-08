/**
 * /api/people/benefits — upload + list benefit documents.
 *
 * GET  → list of uploaded documents (latest first)
 * POST (multipart) → upload a PDF, parse it, store doc + plans, generate
 *      cheapest_practical recommendation, generate insights, return all
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";

// pdf2json uses Node Buffer + filesystem APIs not present on the Edge
// runtime. Force Node.js runtime so the parser can run.
export const runtime = "nodejs";
export const maxDuration = 60;
import {
  parseBenefitDocument,
  saveBenefitDocument,
  generateRecommendation,
  saveRecommendation,
  generateBenefitInsights,
  saveInsights,
  listBenefitDocuments,
} from "@/lib/benefits";
import { trackEvent } from "@/lib/analytics";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const documents = await listBenefitDocuments();
  return NextResponse.json({ documents });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    file = f;
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json({ error: `unsupported type ${file.type} (PDF only)` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (${MAX_BYTES} bytes max)` }, { status: 413 });
  }

  trackEvent("hr.benefit_document_uploaded", user.id, user.role, {
    filename: file.name,
    size_bytes: file.size,
  });

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await parseBenefitDocument(file.name, buffer);
    if (doc.plans.length === 0) {
      trackEvent("hr.benefit_document_parse_failed", user.id, user.role, {
        filename: file.name,
        reason: "no_plans_extracted",
      });
      return NextResponse.json(
        { error: "Could not extract any plan rows from this PDF. The format may not match the parser's expectations." },
        { status: 422 },
      );
    }

    const { documentId } = await saveBenefitDocument(doc, user.id, user.role);
    const recommendation = generateRecommendation(doc.plans, "cheapest_practical");
    let recommendationId: string | null = null;
    if (recommendation) {
      recommendationId = await saveRecommendation(recommendation, documentId, user.id, user.role);
    }
    const insights = generateBenefitInsights(doc.plans);
    if (insights.length > 0) await saveInsights(insights, user.id, user.role);

    return NextResponse.json({
      documentId,
      planCount: doc.plans.length,
      carrier: doc.carrier,
      effectiveDate: doc.effective_date,
      recommendation: recommendation && {
        id: recommendationId,
        rule: recommendation.rule,
        plan_id: recommendation.plan.plan_id,
        plan_name: recommendation.plan.plan_name,
        reasoning: recommendation.reasoning,
        runners_up: recommendation.runners_up.map((r) => ({
          plan_id: r.plan.plan_id,
          plan_name: r.plan.plan_name,
          score: r.score,
          reasons: r.reasons,
        })),
      },
      insights,
    });
  } catch (err) {
    trackEvent("hr.benefit_document_parse_failed", user.id, user.role, {
      filename: file.name,
      error: (err as Error).message.slice(0, 200),
    });
    return NextResponse.json({ error: `parse failed: ${(err as Error).message}` }, { status: 500 });
  }
}
