/**
 * GET  /api/finance/invoices — list invoices (filtered by status).
 * POST /api/finance/invoices — upload + scan via prebuilt-invoice,
 *                              persist row with status='pending'.
 *
 * GET capability: finance.invoices.view
 * POST capability: finance.invoices.manage
 *
 * Dedup: same SHA-256 returns the cached row (no duplicate Azure
 * transaction, no duplicate DB row).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  scanInvoice,
  RECEIPT_MAX_BYTES,
  isFormRecognizerConfigured,
} from "@/lib/azure/form-recognizer";
import {
  findInvoiceBySha,
  insertInvoice,
  listInvoices,
  type InvoiceStatus,
} from "@/lib/finance/invoices";
import { preScanForBlockingPII } from "@/lib/azure/pre-scan";

const MIN_CONFIDENCE = Number(process.env.AZURE_FORM_REC_MIN_CONFIDENCE ?? "0");

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/tiff", "image/bmp", "image/heif",
  "application/pdf",
]);

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "finance.invoices.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") ?? "all") as InvoiceStatus | "all";
  const limit = Number(url.searchParams.get("limit") ?? "200");

  const rows = await listInvoices({
    workspaceId: auth.user.workspaceId,
    status,
    limit,
  });
  return NextResponse.json({ invoices: rows, count: rows.length, status });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "finance.invoices.manage");
  if (!auth.ok) return auth.response;

  if (!isFormRecognizerConfigured()) {
    return NextResponse.json(
      { error: "not_configured", detail: "AZURE_FORM_REC_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set" },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) {
    return NextResponse.json(
      { error: "disallowed_file_type", detail: `${contentType || "unknown"} not in allowlist` },
      { status: 415 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty_file" }, { status: 400 });
  }
  if (file.size > RECEIPT_MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", max_bytes: RECEIPT_MAX_BYTES },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  /* Compliance pre-scan: refuse high-confidence PII / secrets
     before forwarding to Azure (defense in depth on top of DPA). */
  const pre = preScanForBlockingPII(buffer);
  if (!pre.ok) {
    await trackEvent("finance.invoice_scan_failed", auth.user.id, auth.user.role, {
      reason: "pii_blocked",
      blocked_by: pre.blockedBy.join(","),
      filename: file.name,
    });
    return NextResponse.json(
      { error: "pii_blocked", blocked_by: pre.blockedBy, detail: "file contains high-confidence PII / secrets; redact before re-uploading" },
      { status: 422 },
    );
  }

  const sha = createHash("sha256").update(buffer).digest("hex");

  /* Dedup. */
  const existing = await findInvoiceBySha(auth.user.workspaceId, sha);
  if (existing) {
    await trackEvent("finance.invoice_scanned", auth.user.id, auth.user.role, {
      sha, cached: true, filename: file.name,
    });
    return NextResponse.json({
      ok: true, cached: true, invoice_id: existing.id, status: existing.status, fields: existing.fields,
    });
  }

  const scan = await scanInvoice(buffer, {
    triggeredBy: auth.user.id,
    triggeredByRole: auth.user.role,
    contentType,
  });
  if (scan.ok && MIN_CONFIDENCE > 0 && (scan.fields.documentConfidence ?? 1) < MIN_CONFIDENCE) {
    await trackEvent("finance.invoice_scan_failed", auth.user.id, auth.user.role, {
      reason: "low_confidence",
      confidence: scan.fields.documentConfidence ?? 0,
      floor: MIN_CONFIDENCE,
      filename: file.name,
    });
    return NextResponse.json(
      { error: "low_confidence", confidence: scan.fields.documentConfidence ?? 0, floor: MIN_CONFIDENCE, fields: scan.fields },
      { status: 422 },
    );
  }

  if (!scan.ok) {
    await trackEvent("finance.invoice_scan_failed", auth.user.id, auth.user.role, {
      reason: scan.reason, filename: file.name,
    });
    const status =
      scan.reason === "forbidden" || scan.reason === "not_configured" ? 503
        : scan.reason === "rate_limited" ? 429
        : scan.reason === "too_large" ? 413
        : scan.reason === "bad_request" || scan.reason === "no_document_detected" ? 422
        : 502;
    return NextResponse.json({ error: scan.reason, detail: scan.detail }, { status });
  }

  const row = await insertInvoice({
    workspaceId: auth.user.workspaceId,
    uploadedBy: auth.user.id,
    uploadedByEmail: auth.user.email ?? null,
    sha,
    filename: file.name || null,
    contentType,
    sizeBytes: buffer.length,
    fields: scan.fields,
  });

  await trackEvent("finance.invoice_scanned", auth.user.id, auth.user.role, {
    sha, cached: false, invoice_id: row.id,
    vendor: scan.fields.vendorName ?? "",
    total: scan.fields.invoiceTotal ?? 0,
    line_count: scan.fields.lineItems.length,
    confidence: scan.fields.documentConfidence ?? 0,
    filename: file.name,
  });

  return NextResponse.json({ ok: true, cached: false, invoice_id: row.id, status: row.status, fields: scan.fields });
}
