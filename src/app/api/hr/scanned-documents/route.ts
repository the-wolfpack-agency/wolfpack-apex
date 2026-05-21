/**
 * GET  /api/hr/scanned-documents — list by employee or status.
 * POST /api/hr/scanned-documents — upload + extract via prebuilt-
 *      idDocument (for license/passport/state_id) or Computer Vision
 *      OCR (W-9/W-4/voided check/other).
 *
 * GET capability: hr.documents.view
 * POST capability: hr.documents.upload
 *
 * Defense in depth: PII pre-scan refuses bytes containing high-
 * confidence card / SSN / API keys before forwarding to Azure.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  scanIdDocument,
  RECEIPT_MAX_BYTES,
  isFormRecognizerConfigured,
} from "@/lib/azure/form-recognizer";
import { ocrImage, isVisionConfigured } from "@/lib/azure/vision-ocr";
import { preScanForBlockingPII } from "@/lib/azure/pre-scan";
import {
  findHrDocBySha,
  insertHrDoc,
  listHrDocs,
  ID_DOC_TYPES,
  type HrDocStatus,
  type HrDocType,
} from "@/lib/hr/scanned-documents";

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/tiff",
  "image/bmp", "image/heif", "application/pdf",
]);

const VALID_DOC_TYPES: HrDocType[] = [
  "license", "passport", "state_id",
  "w2", "w4", "w9", "i9",
  "voided_check", "direct_deposit", "other",
];

const MIN_CONFIDENCE = Number(process.env.AZURE_FORM_REC_MIN_CONFIDENCE ?? "0");

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "hr.documents.view");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const employeeEmail = url.searchParams.get("employee_email") ?? undefined;
  const status = (url.searchParams.get("status") ?? "all") as HrDocStatus | "all";
  const rows = await listHrDocs({
    workspaceId: auth.user.workspaceId,
    employeeEmail,
    status,
  });
  return NextResponse.json({ documents: rows, count: rows.length });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "hr.documents.upload");
  if (!auth.ok) return auth.response;

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "invalid multipart body" }, { status: 400 }); }

  const file = form.get("file");
  const employeeEmail = (form.get("employee_email") || "").toString().trim().toLowerCase();
  const employeeName = (form.get("employee_name") || "").toString().trim() || null;
  const teamMemberId = (form.get("team_member_id") || "").toString().trim() || null;
  const docType = (form.get("doc_type") || "").toString() as HrDocType;

  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!employeeEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(employeeEmail)) {
    return NextResponse.json({ error: "employee_email required (valid email)" }, { status: 400 });
  }
  if (!VALID_DOC_TYPES.includes(docType)) {
    return NextResponse.json({ error: "doc_type required", allowed: VALID_DOC_TYPES }, { status: 400 });
  }
  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) {
    return NextResponse.json({ error: "disallowed_file_type", detail: contentType }, { status: 415 });
  }
  if (file.size === 0) return NextResponse.json({ error: "empty_file" }, { status: 400 });
  if (file.size > RECEIPT_MAX_BYTES) {
    return NextResponse.json({ error: "file_too_large", max_bytes: RECEIPT_MAX_BYTES }, { status: 413 });
  }

  const isIdType = ID_DOC_TYPES.has(docType);
  if (isIdType && !isFormRecognizerConfigured()) {
    return NextResponse.json({ error: "not_configured", detail: "Azure Form Recognizer not configured" }, { status: 503 });
  }
  if (!isIdType && !isVisionConfigured()) {
    return NextResponse.json({ error: "not_configured", detail: "Azure Computer Vision not configured" }, { status: 503 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const pre = preScanForBlockingPII(buffer);
  if (!pre.ok) {
    await trackEvent("hr.document_scan_failed", auth.user.id, auth.user.role, {
      reason: "pii_blocked", blocked_by: pre.blockedBy.join(","), doc_type: docType,
    });
    return NextResponse.json(
      { error: "pii_blocked", blocked_by: pre.blockedBy, detail: "file contains high-confidence PII / secrets; redact before re-uploading" },
      { status: 422 },
    );
  }

  const sha = createHash("sha256").update(buffer).digest("hex");
  const existing = await findHrDocBySha(auth.user.workspaceId, sha);
  if (existing) {
    await trackEvent("hr.document_scanned", auth.user.id, auth.user.role, {
      sha, cached: true, doc_type: docType, employee_email: employeeEmail,
    });
    return NextResponse.json({ ok: true, cached: true, document_id: existing.id, status: existing.status });
  }

  let idFields = null;
  let extractedText: string | null = null;
  if (isIdType) {
    const r = await scanIdDocument(buffer, {
      triggeredBy: auth.user.id, triggeredByRole: auth.user.role, contentType,
    });
    if (!r.ok) {
      await trackEvent("hr.document_scan_failed", auth.user.id, auth.user.role, {
        reason: r.reason, doc_type: docType,
      });
      const status = r.reason === "rate_limited" ? 429
        : r.reason === "forbidden" || r.reason === "not_configured" ? 503
        : r.reason === "too_large" ? 413
        : r.reason === "bad_request" || r.reason === "no_document_detected" ? 422
        : 502;
      return NextResponse.json({ error: r.reason, detail: r.detail }, { status });
    }
    if (MIN_CONFIDENCE > 0 && (r.fields.documentConfidence ?? 1) < MIN_CONFIDENCE) {
      await trackEvent("hr.document_scan_failed", auth.user.id, auth.user.role, {
        reason: "low_confidence", confidence: r.fields.documentConfidence ?? 0, doc_type: docType,
      });
      return NextResponse.json({ error: "low_confidence", confidence: r.fields.documentConfidence, floor: MIN_CONFIDENCE, fields: r.fields }, { status: 422 });
    }
    idFields = r.fields;
    extractedText = r.fields.rawText;
  } else {
    const r = await ocrImage(buffer, {
      triggeredBy: auth.user.id, triggeredByRole: auth.user.role, contentType,
    });
    if (!r.ok) {
      await trackEvent("hr.document_scan_failed", auth.user.id, auth.user.role, {
        reason: r.reason, doc_type: docType,
      });
      const status = r.reason === "rate_limited" ? 429
        : r.reason === "forbidden" || r.reason === "not_configured" ? 503
        : r.reason === "too_large" ? 413
        : 502;
      return NextResponse.json({ error: r.reason, detail: r.detail }, { status });
    }
    extractedText = r.text;
  }

  const row = await insertHrDoc({
    workspaceId: auth.user.workspaceId,
    uploadedBy: auth.user.id,
    uploadedByEmail: auth.user.email ?? null,
    sha,
    filename: file.name || null,
    contentType,
    sizeBytes: buffer.length,
    teamMemberId,
    employeeEmail,
    employeeName,
    docType,
    idFields,
    extractedText,
  });

  await trackEvent("hr.document_scanned", auth.user.id, auth.user.role, {
    sha, cached: false, document_id: row.id, doc_type: docType,
    employee_email: employeeEmail,
    extraction_kind: isIdType ? "id_document" : "ocr",
    confidence: idFields?.documentConfidence ?? 0,
  });

  return NextResponse.json({
    ok: true, cached: false,
    document_id: row.id, status: row.status,
    fields: idFields, extracted_text_length: extractedText?.length ?? 0,
  });
}
