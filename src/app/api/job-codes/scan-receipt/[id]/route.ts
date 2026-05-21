/**
 * GET /api/job-codes/scan-receipt/[id] — rehydrate a previously
 * persisted receipt scan so a downstream page can pick up the apply
 * flow without re-uploading the bytes.
 *
 * Used by the cross-page intake router: a user drops a receipt on
 * /finance/invoices, we POST to /scan-receipt, then redirect to
 * /job-codes?pending_scan=<id>. The receiving page calls this GET
 * to pull merchant / total / date etc. back into the apply modal.
 *
 * Workspace-scoped: a scan row from another workspace returns 404,
 * not 403 (same shape as the apply endpoint — never confirm the
 * existence of a foreign scan).
 *
 * Capability: jobcodes.refresh (same gate as the POST that created
 * the row — only people who can write to job-code cells need to read
 * back a scan they intend to apply).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";
import type { ReceiptFields } from "@/lib/azure/form-recognizer";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "jobcodes.refresh");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const res = await query<{
    id: string;
    fields: ReceiptFields;
    original_filename: string | null;
    uploaded_at: string;
    applied_to_code: string | null;
    applied_at: string | null;
  }>(
    `SELECT id, fields, original_filename, uploaded_at, applied_to_code, applied_at
     FROM instinct_receipt_scans
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [id, auth.user.workspaceId],
  );
  if (res.rows.length === 0) {
    return NextResponse.json({ error: "scan_not_found" }, { status: 404 });
  }
  const row = res.rows[0];
  return NextResponse.json({
    ok: true,
    scan_id: row.id,
    fields: row.fields,
    original_filename: row.original_filename,
    uploaded_at: row.uploaded_at,
    applied_to_code: row.applied_to_code,
    applied_at: row.applied_at,
  });
}
