/**
 * POST /api/job-codes/scan-receipt — extract fields from a receipt
 * via Azure Document Intelligence, persist them, return them to the
 * caller.
 *
 * Side effects:
 *   - One Form Recognizer transaction (free-tier counter).
 *   - One instinct_receipt_scans row (UPSERTed by SHA-256 so the
 *     same receipt doesn't burn a second transaction).
 *   - One instinct_azure_calls audit row (cost forecast).
 *
 * No SharePoint writes happen here — applying the values to a job
 * code is a separate explicit user action (the "Apply" button in the
 * UI hits PATCH /api/job-codes/[code]/cell, which is gated + audited
 * the same way an inline edit is).
 *
 * Security:
 *   - Capability: jobcodes.refresh (admin-only — receipts contain
 *     financial info; only senior roles can scan them).
 *   - File-size cap 3.5 MB (matches RECEIPT_MAX_BYTES; rejects bigger
 *     before burning an Azure transaction).
 *   - MIME allowlist (image/jpeg, image/png, image/tiff, application/
 *     pdf) — Form Recognizer rejects others.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { writeQuery, query } from "@/lib/db";
import {
  scanReceipt,
  RECEIPT_MAX_BYTES,
  isFormRecognizerConfigured,
} from "@/lib/azure/form-recognizer";
import type { ReceiptFields } from "@/lib/azure/form-recognizer";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/tiff",
  "image/bmp",
  "image/heif",
  "application/pdf",
]);

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "jobcodes.refresh");
  if (!auth.ok) return auth.response;

  if (!isFormRecognizerConfigured()) {
    return NextResponse.json(
      {
        error: "not_configured",
        detail: "AZURE_FORM_REC_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set in this environment",
      },
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
      {
        error: "disallowed_file_type",
        detail: `${contentType || "unknown"} not in allowlist (${[...ALLOWED_MIME].join(", ")})`,
      },
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
  const sha = createHash("sha256").update(buffer).digest("hex");

  /* Dedup: same receipt uploaded twice → reuse the existing row +
     extraction. Don't pay Form Recognizer a second transaction. */
  const existing = await query<{
    id: string;
    fields: ReceiptFields;
    uploaded_at: string;
  }>(
    `SELECT id, fields, uploaded_at FROM instinct_receipt_scans
     WHERE workspace_id = $1 AND raw_bytes_sha256 = $2
     LIMIT 1`,
    [auth.user.workspaceId, sha],
  );
  if (existing.rows[0]) {
    await trackEvent("jobcodes.receipt_scanned", auth.user.id, auth.user.role, {
      sha,
      cached: true,
      filename: file.name,
    });
    return NextResponse.json({
      ok: true,
      cached: true,
      scan_id: existing.rows[0].id,
      fields: existing.rows[0].fields,
    });
  }

  const scan = await scanReceipt(buffer, {
    triggeredBy: auth.user.id,
    triggeredByRole: auth.user.role,
    contentType,
  });

  if (!scan.ok) {
    await trackEvent("jobcodes.receipt_scan_failed", auth.user.id, auth.user.role, {
      reason: scan.reason,
      filename: file.name,
    });
    const status =
      scan.reason === "forbidden" || scan.reason === "not_configured" ? 503
        : scan.reason === "rate_limited" ? 429
        : scan.reason === "too_large" ? 413
        : scan.reason === "bad_request" || scan.reason === "no_document_detected" ? 422
        : 502;
    return NextResponse.json(
      { error: scan.reason, detail: scan.detail },
      { status },
    );
  }

  const inserted = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_receipt_scans
       (workspace_id, uploaded_by, uploaded_by_email, raw_bytes_sha256,
        original_filename, content_type, size_bytes, fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      auth.user.workspaceId,
      auth.user.id,
      auth.user.email ?? null,
      sha,
      file.name || null,
      contentType,
      buffer.length,
      JSON.stringify(scan.fields),
    ],
    { expectRows: 1 },
  );

  await trackEvent("jobcodes.receipt_scanned", auth.user.id, auth.user.role, {
    sha,
    cached: false,
    scan_id: inserted.rows[0].id,
    merchant: scan.fields.merchantName ?? "",
    total: scan.fields.total ?? 0,
    item_count: scan.fields.items.length,
    confidence: scan.fields.documentConfidence ?? 0,
    filename: file.name,
  });

  return NextResponse.json({
    ok: true,
    cached: false,
    scan_id: inserted.rows[0].id,
    fields: scan.fields,
  });
}
