/**
 * /api/people/documents — list + smart-router upload.
 *
 * GET ?category=w4|i9|... — filter by category, or all if omitted.
 *
 * POST (multipart): file + optional source ('documents_tab' | 'benefits_tab')
 *   Smart-routes the upload through hr-documents.routeUpload, which:
 *     1. Extracts text via unpdf
 *     2. Classifies the doc deterministically (zero AI tokens)
 *     3. Persists in apex_hr_documents
 *     4. If classified as benefits_renewal, also runs the benefits
 *        pipeline so the Benefits tab has its plans + recommendation
 *     5. Returns the routing result so the UI can show "Filed as W-4"
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listHrDocuments, routeUpload, type HrCategory, HR_CATEGORIES } from "@/lib/hr-documents";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const categoryParam = req.nextUrl.searchParams.get("category");
  const category = (HR_CATEGORIES as readonly string[]).includes(categoryParam ?? "")
    ? (categoryParam as HrCategory)
    : undefined;
  const documents = await listHrDocuments(category ? { category } : undefined);
  return NextResponse.json({ documents });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let file: File;
  let source: "documents_tab" | "benefits_tab" = "documents_tab";
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    file = f;
    const srcParam = String(form.get("source") ?? "documents_tab");
    if (srcParam === "benefits_tab") source = "benefits_tab";
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json({ error: `unsupported type ${file.type} (PDF only)` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (${MAX_BYTES} bytes max)` }, { status: 413 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await routeUpload(file.name, buffer, user.id, user.role, source);
    return NextResponse.json(result);
  } catch (err) {
    trackEvent("hr.document_uploaded", user.id, user.role, {
      filename: file.name,
      error: (err as Error).message.slice(0, 200),
    });
    return NextResponse.json({ error: `upload failed: ${(err as Error).message}` }, { status: 500 });
  }
}
