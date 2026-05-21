/**
 * AP invoice repo. Writes go through writeQuery so silent drops are
 * impossible; reads use safeQuery for graceful shadow-mode fallback.
 */

import { query, writeQuery } from "@/lib/db";
import type { InvoiceFields } from "@/lib/azure/form-recognizer";

export type InvoiceStatus = "pending" | "approved" | "paid" | "rejected";

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  uploaded_by: string;
  uploaded_by_email: string | null;
  uploaded_at: string;
  raw_bytes_sha256: string;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  currency: string | null;
  line_items: unknown;
  extracted_fields: unknown;
  status: InvoiceStatus;
  approved_by: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  paid_at: string | null;
  rejected_reason: string | null;
  notes: string | null;
  updated_at: string;
  assigned_job_code: string | null;
  [key: string]: unknown;
}

export interface FindByShaResult {
  id: string;
  fields: InvoiceFields;
  status: InvoiceStatus;
  uploaded_at: string;
}

export async function findInvoiceBySha(workspaceId: string, sha: string): Promise<FindByShaResult | null> {
  const res = await query<{ id: string; extracted_fields: InvoiceFields; status: InvoiceStatus; uploaded_at: string }>(
    `SELECT id, extracted_fields, status, uploaded_at FROM instinct_invoices
     WHERE workspace_id = $1 AND raw_bytes_sha256 = $2 LIMIT 1`,
    [workspaceId, sha],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id, fields: row.extracted_fields, status: row.status, uploaded_at: row.uploaded_at };
}

export interface InsertInvoiceInput {
  workspaceId: string;
  uploadedBy: string;
  uploadedByEmail: string | null;
  sha: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  fields: InvoiceFields;
}

export async function insertInvoice(input: InsertInvoiceInput): Promise<InvoiceRow> {
  const res = await writeQuery<InvoiceRow>(
    `INSERT INTO instinct_invoices
       (workspace_id, uploaded_by, uploaded_by_email, raw_bytes_sha256,
        original_filename, content_type, size_bytes,
        vendor_name, invoice_number, invoice_date, due_date,
        subtotal, tax, total, currency, line_items, extracted_fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10::date, $11::date,
             $12, $13, $14, $15, $16::jsonb, $17::jsonb)
     RETURNING *`,
    [
      input.workspaceId,
      input.uploadedBy,
      input.uploadedByEmail,
      input.sha,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.fields.vendorName,
      input.fields.invoiceId,
      input.fields.invoiceDate,
      input.fields.dueDate,
      input.fields.subtotal,
      input.fields.totalTax,
      input.fields.invoiceTotal,
      input.fields.currency,
      JSON.stringify(input.fields.lineItems),
      JSON.stringify(input.fields),
    ],
    { expectRows: 1 },
  );
  return res.rows[0];
}

export interface ListInvoicesOptions {
  workspaceId: string;
  status?: InvoiceStatus | "all";
  limit?: number;
}

/** Workspace-wide counts per status — separate from the filtered
 *  list so chip labels stay accurate regardless of what's loaded. */
export async function countInvoicesByStatus(workspaceId: string): Promise<Record<InvoiceStatus, number>> {
  const res = await query<{ status: InvoiceStatus; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM instinct_invoices
     WHERE workspace_id = $1 GROUP BY status`,
    [workspaceId],
  );
  const counts: Record<InvoiceStatus, number> = { pending: 0, approved: 0, paid: 0, rejected: 0 };
  for (const r of res.rows) counts[r.status] = r.n;
  return counts;
}

export async function listInvoices(opts: ListInvoicesOptions): Promise<InvoiceRow[]> {
  const args: unknown[] = [opts.workspaceId];
  const where: string[] = [`workspace_id = $1`];
  if (opts.status && opts.status !== "all") {
    args.push(opts.status);
    where.push(`status = $${args.length}`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const res = await query<InvoiceRow>(
    `SELECT * FROM instinct_invoices
     WHERE ${where.join(" AND ")}
     ORDER BY uploaded_at DESC
     LIMIT ${limit}`,
    args,
  );
  return res.rows;
}

export async function getInvoice(workspaceId: string, id: string): Promise<InvoiceRow | null> {
  const res = await query<InvoiceRow>(
    `SELECT * FROM instinct_invoices WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
    [workspaceId, id],
  );
  return res.rows[0] ?? null;
}

/* Allow only an explicit allowlist of mutable columns so a buggy
   caller can't overwrite uploaded_by / sha / extracted_fields by
   passing them in the patch body. */
const PATCHABLE_COLUMNS = new Set([
  "vendor_name",
  "invoice_number",
  "invoice_date",
  "due_date",
  "subtotal",
  "tax",
  "total",
  "currency",
  "status",
  "rejected_reason",
  "notes",
  "assigned_job_code",
]);

export interface PatchInvoiceInput {
  workspaceId: string;
  id: string;
  changes: Record<string, string | number | null>;
  /** Acting user — used to populate approved_by / approved_at /
   *  paid_at when status transitions trigger them. */
  actorId: string;
  actorEmail: string | null;
}

export async function patchInvoice(input: PatchInvoiceInput): Promise<InvoiceRow | null> {
  const setFragments: string[] = [];
  const args: unknown[] = [];
  let next = 1;
  for (const [k, v] of Object.entries(input.changes)) {
    if (!PATCHABLE_COLUMNS.has(k)) continue;
    args.push(v);
    /* Cast date fields explicitly because PG won't accept a TEXT for
       DATE columns. */
    const cast = k === "invoice_date" || k === "due_date" ? "::date" : "";
    setFragments.push(`${k} = $${next}${cast}`);
    next++;
  }
  if (setFragments.length === 0) {
    /* No-op patch — return the current row so callers don't think
       it disappeared. */
    return getInvoice(input.workspaceId, input.id);
  }

  /* Status-transition side effects — set the audit columns when the
     status moves to approved/paid/rejected. The status column itself
     is already on setFragments because it's in PATCHABLE_COLUMNS. */
  const newStatus = input.changes.status as InvoiceStatus | undefined;
  if (newStatus === "approved") {
    setFragments.push(`approved_by = $${next}`);
    args.push(input.actorId);
    next++;
    setFragments.push(`approved_by_email = $${next}`);
    args.push(input.actorEmail);
    next++;
    setFragments.push(`approved_at = NOW()`);
  } else if (newStatus === "paid") {
    setFragments.push(`paid_at = NOW()`);
  }
  setFragments.push(`updated_at = NOW()`);

  args.push(input.workspaceId);
  const wsIdx = next++;
  args.push(input.id);
  const idIdx = next++;

  const res = await writeQuery<InvoiceRow>(
    `UPDATE instinct_invoices
     SET ${setFragments.join(", ")}
     WHERE workspace_id = $${wsIdx} AND id = $${idIdx}
     RETURNING *`,
    args,
  );
  return res.rows[0] ?? null;
}

export async function deleteInvoice(workspaceId: string, id: string): Promise<boolean> {
  const res = await writeQuery<{ id: string }>(
    `DELETE FROM instinct_invoices WHERE workspace_id = $1 AND id = $2 RETURNING id`,
    [workspaceId, id],
  );
  return res.rows.length > 0;
}
