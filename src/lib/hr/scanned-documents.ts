/**
 * HR scanned-documents repo. Sister to lib/finance/invoices.ts;
 * same writeQuery / safeQuery / dedup pattern.
 */

import { query, writeQuery } from "@/lib/db";
import type { IdDocumentFields } from "@/lib/azure/form-recognizer";

export type HrDocType =
  | "license" | "passport" | "state_id"
  | "w2" | "w4" | "w9" | "i9"
  | "voided_check" | "direct_deposit" | "other";

export type HrDocStatus = "pending" | "verified" | "rejected" | "expired";

export interface HrDocRow {
  id: string;
  workspace_id: string;
  uploaded_by: string;
  uploaded_by_email: string | null;
  uploaded_at: string;
  raw_bytes_sha256: string;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number;
  team_member_id: string | null;
  employee_email: string;
  employee_name: string | null;
  doc_type: HrDocType;
  document_number: string | null;
  document_expiry: string | null;
  full_name: string | null;
  extracted_fields: unknown;
  extracted_text: string | null;
  status: HrDocStatus;
  verified_by: string | null;
  verified_at: string | null;
  rejected_reason: string | null;
  notes: string | null;
  updated_at: string;
  [key: string]: unknown;
}

/** Doc types where prebuilt-idDocument applies. Others use OCR. */
export const ID_DOC_TYPES: ReadonlySet<HrDocType> = new Set(["license", "passport", "state_id"]);

export async function findHrDocBySha(workspaceId: string, sha: string): Promise<HrDocRow | null> {
  const res = await query<HrDocRow>(
    `SELECT * FROM instinct_hr_scanned_documents
     WHERE workspace_id = $1 AND raw_bytes_sha256 = $2 LIMIT 1`,
    [workspaceId, sha],
  );
  return res.rows[0] ?? null;
}

export interface InsertHrDocInput {
  workspaceId: string;
  uploadedBy: string;
  uploadedByEmail: string | null;
  sha: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  teamMemberId: string | null;
  employeeEmail: string;
  employeeName: string | null;
  docType: HrDocType;
  idFields: IdDocumentFields | null;
  extractedText: string | null;
}

export async function insertHrDoc(input: InsertHrDocInput): Promise<HrDocRow> {
  const fields = input.idFields ?? {};
  const res = await writeQuery<HrDocRow>(
    `INSERT INTO instinct_hr_scanned_documents
       (workspace_id, uploaded_by, uploaded_by_email, raw_bytes_sha256,
        original_filename, content_type, size_bytes,
        team_member_id, employee_email, employee_name, doc_type,
        document_number, document_expiry, full_name,
        extracted_fields, extracted_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15::jsonb,$16)
     RETURNING *`,
    [
      input.workspaceId, input.uploadedBy, input.uploadedByEmail, input.sha,
      input.filename, input.contentType, input.sizeBytes,
      input.teamMemberId, input.employeeEmail, input.employeeName, input.docType,
      input.idFields?.documentNumber ?? null,
      input.idFields?.dateOfExpiration ?? null,
      input.idFields?.fullName ?? null,
      JSON.stringify(fields),
      input.extractedText,
    ],
    { expectRows: 1 },
  );
  return res.rows[0];
}

export interface ListHrDocsOptions {
  workspaceId: string;
  employeeEmail?: string;
  status?: HrDocStatus | "all";
  limit?: number;
}

export async function listHrDocs(opts: ListHrDocsOptions): Promise<HrDocRow[]> {
  const args: unknown[] = [opts.workspaceId];
  const where: string[] = [`workspace_id = $1`];
  if (opts.employeeEmail) {
    args.push(opts.employeeEmail);
    where.push(`employee_email = $${args.length}`);
  }
  if (opts.status && opts.status !== "all") {
    args.push(opts.status);
    where.push(`status = $${args.length}`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const res = await query<HrDocRow>(
    `SELECT * FROM instinct_hr_scanned_documents
     WHERE ${where.join(" AND ")}
     ORDER BY uploaded_at DESC LIMIT ${limit}`,
    args,
  );
  return res.rows;
}

export async function getHrDoc(workspaceId: string, id: string): Promise<HrDocRow | null> {
  const res = await query<HrDocRow>(
    `SELECT * FROM instinct_hr_scanned_documents WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
    [workspaceId, id],
  );
  return res.rows[0] ?? null;
}

const PATCHABLE = new Set([
  "status", "rejected_reason", "notes", "employee_name", "team_member_id",
  "document_number", "document_expiry", "full_name",
]);

export async function patchHrDoc(input: {
  workspaceId: string;
  id: string;
  changes: Record<string, string | null>;
  actorId: string;
}): Promise<HrDocRow | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  let n = 1;
  for (const [k, v] of Object.entries(input.changes)) {
    if (!PATCHABLE.has(k)) continue;
    args.push(v);
    const cast = k === "document_expiry" ? "::date" : "";
    sets.push(`${k} = $${n}${cast}`);
    n++;
  }
  if (sets.length === 0) return getHrDoc(input.workspaceId, input.id);
  if (input.changes.status === "verified") {
    sets.push(`verified_by = $${n}`); args.push(input.actorId); n++;
    sets.push(`verified_at = NOW()`);
  }
  sets.push(`updated_at = NOW()`);
  args.push(input.workspaceId);
  const ws = n++;
  args.push(input.id);
  const id = n++;
  const res = await writeQuery<HrDocRow>(
    `UPDATE instinct_hr_scanned_documents SET ${sets.join(", ")}
     WHERE workspace_id = $${ws} AND id = $${id} RETURNING *`,
    args,
  );
  return res.rows[0] ?? null;
}

export async function deleteHrDoc(workspaceId: string, id: string): Promise<boolean> {
  const res = await writeQuery<{ id: string }>(
    `DELETE FROM instinct_hr_scanned_documents WHERE workspace_id = $1 AND id = $2 RETURNING id`,
    [workspaceId, id],
  );
  return res.rows.length > 0;
}
