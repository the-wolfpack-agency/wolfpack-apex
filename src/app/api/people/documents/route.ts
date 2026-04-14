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

// Rate limit: 20 uploads per user per hour
const uploadAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_UPLOADS = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const categoryParam = req.nextUrl.searchParams.get("category");
  const employeeIdParam = req.nextUrl.searchParams.get("employee_id");
  const category = (HR_CATEGORIES as readonly string[]).includes(categoryParam ?? "")
    ? (categoryParam as HrCategory)
    : undefined;
  const filter: { category?: HrCategory; employee_id?: string } = {};
  if (category) filter.category = category;
  if (employeeIdParam) filter.employee_id = employeeIdParam;
  const documents = await listHrDocuments(Object.keys(filter).length > 0 ? filter : undefined);
  return NextResponse.json({ documents });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Upload rate limiting
  const now = Date.now();
  const entry = uploadAttempts.get(user.id);
  if (entry && now < entry.resetAt) {
    entry.count++;
    if (entry.count > MAX_UPLOADS) {
      trackEvent("system.upload_rate_limited", user.id, user.role, { endpoint: "people/documents" });
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return NextResponse.json(
        { error: "Too many uploads. Please try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  } else {
    uploadAttempts.set(user.id, { count: 1, resetAt: now + UPLOAD_WINDOW_MS });
  }

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
    console.error("[people/documents]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
