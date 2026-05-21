/**
 * POST /api/job-codes/scan-receipt/[id]/apply — mark a persisted scan
 * as applied to a job code.
 *
 * The actual SharePoint writes go through the existing
 * /api/job-codes/[code]/cell endpoint (so audit + allowlist live in
 * one place). THIS route just records WHICH job code received the
 * scanned values and what the user actually committed — so the
 * learning loop can compute model-vs-human drift.
 *
 * Body: { code, program, po_number, po_amount } — caller passes the
 * final values that landed in SharePoint (echoed from the cell PATCH
 * responses). NULL fields mean the user chose not to apply that
 * extracted value.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { writeQuery } from "@/lib/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "jobcodes.refresh");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    code?: string;
    program?: string | null;
    po_number?: string | null;
    po_amount?: string | null;
  } | null;
  if (!body || typeof body.code !== "string" || !body.code.trim()) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

  const res = await writeQuery<{ id: string }>(
    `UPDATE instinct_receipt_scans
     SET applied_to_code = $2,
         applied_at = NOW(),
         applied_program = $3,
         applied_po_number = $4,
         applied_po_amount = $5
     WHERE id = $1 AND workspace_id = $6
     RETURNING id`,
    [
      id,
      body.code.trim(),
      body.program ?? null,
      body.po_number ?? null,
      body.po_amount ?? null,
      auth.user.workspaceId,
    ],
  );
  if (res.rows.length === 0) {
    return NextResponse.json({ error: "scan_not_found" }, { status: 404 });
  }

  await trackEvent("jobcodes.receipt_applied", auth.user.id, auth.user.role, {
    scan_id: id,
    code: body.code,
    applied_program: !!body.program,
    applied_po_number: !!body.po_number,
    applied_po_amount: !!body.po_amount,
  });

  return NextResponse.json({ ok: true, scan_id: id });
}
