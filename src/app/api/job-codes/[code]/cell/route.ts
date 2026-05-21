/**
 * PATCH /api/job-codes/[code]/cell — edit a single allowlisted column
 * (D / E / F → Program / PO Number / PO Amount) on the SharePoint
 * workbook row that matches the path code.
 *
 * Capability: jobcodes.refresh (admin-only). Editing financial data
 * is a workspace-wide write; only leadership roles can do it.
 *
 * Body: { column: "D" | "E" | "F", value: string }
 *
 * Side effects (in this order):
 *   1. cell-writer PATCHes the workbook (Graph API, single cell)
 *   2. cache row's `extra` JSONB is updated with the new value so the
 *      page reflects the change immediately
 *   3. instinct_job_codes_edits audit row is written with status +
 *      old/new values, regardless of Graph outcome
 *   4. typed analytics event fires for the learning loop
 *
 * No-op on forbidden columns (the writer hard-refuses B/C even
 * if the API somehow forwards them — defense in depth).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  patchJobCodeCell,
  EDITABLE_HEADERS,
  LETTER_TO_HEADER,
  type EditableHeader,
} from "@/lib/job-codes/cell-writer";
import {
  findJobCodeBySource,
  recordCellEdit,
  updateExtraCell,
} from "@/lib/job-codes/repo";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const auth = await requireCapability(req, "jobcodes.refresh");
  if (!auth.ok) return auth.response;

  const { code } = await params;
  if (!code) return NextResponse.json({ error: "code required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { column?: string; column_name?: string; value?: string } | null;
  if (!body || typeof body.value !== "string") {
    return NextResponse.json(
      { error: "body must include `value` (string) and either `column_name` or `column`" },
      { status: 400 },
    );
  }
  /* Resolve to a canonical column header. Accept either column_name
     (preferred) or column letter (backward-compat). */
  let columnHeader: EditableHeader | null = null;
  if (typeof body.column_name === "string" && (EDITABLE_HEADERS as readonly string[]).includes(body.column_name)) {
    columnHeader = body.column_name as EditableHeader;
  } else if (typeof body.column === "string") {
    const mapped = LETTER_TO_HEADER[body.column.toUpperCase()];
    if (mapped) columnHeader = mapped;
  }
  if (!columnHeader) {
    return NextResponse.json(
      { error: "forbidden_column", detail: `column_name must be one of ${EDITABLE_HEADERS.join(", ")}` },
      { status: 400 },
    );
  }

  const cached = await findJobCodeBySource(code);
  if (!cached) {
    return NextResponse.json(
      {
        error: "code_not_in_cache",
        detail: "the job code is not in the cache OR the cache has no source pointer yet — refresh first",
      },
      { status: 404 },
    );
  }

  const writeRes = await patchJobCodeCell({
    triggeredBy: auth.user.id,
    driveId: cached.driveId,
    itemId: cached.itemId,
    sheetName: cached.sheetName,
    jobCode: code,
    columnName: columnHeader,
    value: body.value,
  });

  if (!writeRes.ok) {
    /* Best-effort audit even on failure — the human attempt is itself
       worth recording so we can see "Hoxsie tried to set PO Amount
       three times but Graph kept 403ing". */
    await recordCellEdit({
      workspaceId: auth.user.workspaceId,
      code,
      columnName: columnHeader,
      oldValue: null,
      newValue: body.value,
      editedBy: auth.user.id,
      editedByEmail: auth.user.email ?? null,
      editedByRole: auth.user.role,
      status: "failed",
      graphError: writeRes.detail,
    }).catch(() => undefined);

    await trackEvent("jobcodes.cell_edit_failed", auth.user.id, auth.user.role, {
      code,
      column_header: columnHeader,
      reason: writeRes.code,
    });

    const status = writeRes.code === "forbidden_column" ? 400
      : writeRes.code === "code_not_found" ? 404
      : writeRes.code === "graph_forbidden" ? 502
      : writeRes.code === "not_configured" ? 503
      : 502;
    return NextResponse.json(
      { error: writeRes.code, detail: writeRes.detail },
      { status },
    );
  }

  /* Success path. Mirror the new value into the cache row so the
     page reflects it before the next full refresh. */
  await updateExtraCell(code, columnHeader, writeRes.newValue).catch(() => undefined);
  await recordCellEdit({
    workspaceId: auth.user.workspaceId,
    code,
    columnName: columnHeader,
    oldValue: writeRes.previousValue,
    newValue: writeRes.newValue,
    editedBy: auth.user.id,
    editedByEmail: auth.user.email ?? null,
    editedByRole: auth.user.role,
    status: "succeeded",
  }).catch(() => undefined);

  await trackEvent("jobcodes.cell_edit_succeeded", auth.user.id, auth.user.role, {
    code,
    column_header: columnHeader,
    previous_value: writeRes.previousValue.slice(0, 80),
    new_value: writeRes.newValue.slice(0, 80),
    token_kind: writeRes.tokenKind,
    row_index: writeRes.rowIndex,
  });

  return NextResponse.json({
    ok: true,
    code,
    column_header: columnHeader,
    cell_address: writeRes.cellAddress,
    row_index: writeRes.rowIndex,
    previous_value: writeRes.previousValue,
    new_value: writeRes.newValue,
  });
}
