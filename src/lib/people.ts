/**
 * People (HR) employee CRUD — minimal v1.
 *
 * Backs the Employees sub-tab. Closed-loop: every CRUD action emits a
 * tracked event so the brain learns onboarding cadence (time between
 * `hr.employee_added` events), team growth, and so forth.
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface Employee {
  id: string;
  full_name: string;
  email: string | null;
  role_title: string | null;
  department: string | null;
  start_date: string | null;
  birth_year: number | null;
  zip_code: string | null;
  status: "active" | "onboarding" | "terminated";
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function listEmployees(): Promise<Employee[]> {
  const r = await safeQuery(`SELECT * FROM apex_employees ORDER BY start_date DESC NULLS LAST, full_name ASC`);
  return r.rows as unknown as Employee[];
}

export async function createEmployee(input: Partial<Employee>, createdBy: string, userRole: string): Promise<Employee> {
  if (!input.full_name) throw new Error("full_name required");
  const id = `emp_${randomUUID()}`;
  const r = await safeQuery(
    `INSERT INTO apex_employees (id, full_name, email, role_title, department, start_date, birth_year, zip_code, status, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      id,
      input.full_name,
      input.email ?? null,
      input.role_title ?? null,
      input.department ?? null,
      input.start_date ?? null,
      input.birth_year ?? null,
      input.zip_code ?? null,
      input.status ?? "onboarding",
      JSON.stringify(input.metadata ?? {}),
      createdBy,
    ],
  );
  trackEvent("hr.employee_added", createdBy, userRole, {
    employee_id: id,
    full_name: input.full_name,
    department: input.department ?? "",
  });
  return r.rows[0] as unknown as Employee;
}

/**
 * Fetch a single employee by id. Returns null when the row doesn't exist
 * (so route handlers can 404 cleanly without throwing).
 */
export async function getEmployee(id: string): Promise<Employee | null> {
  const r = await safeQuery(`SELECT * FROM apex_employees WHERE id = $1`, [id]);
  if (r.rows.length === 0) return null;
  return r.rows[0] as unknown as Employee;
}

/**
 * updateEmployee — partial-field update of an existing row.
 *
 * Columns NOT in the input are left untouched via COALESCE. `metadata` is
 * replaced wholesale when provided (it's a JSONB blob — merging is caller
 * responsibility). Fires `hr.employee_updated` on every real update.
 * Returns null when the WHERE clause matches no row.
 */
export async function updateEmployee(
  id: string,
  input: Partial<Employee>,
  updatedBy: string,
  userRole: string,
): Promise<Employee | null> {
  const r = await safeQuery(
    `UPDATE apex_employees
        SET full_name  = COALESCE($2, full_name),
            email      = COALESCE($3, email),
            role_title = COALESCE($4, role_title),
            department = COALESCE($5, department),
            start_date = COALESCE($6, start_date),
            birth_year = COALESCE($7, birth_year),
            zip_code   = COALESCE($8, zip_code),
            status     = COALESCE($9, status),
            metadata   = COALESCE($10::jsonb, metadata),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      id,
      input.full_name ?? null,
      input.email ?? null,
      input.role_title ?? null,
      input.department ?? null,
      input.start_date ?? null,
      input.birth_year ?? null,
      input.zip_code ?? null,
      input.status ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as unknown as Employee;
  // Fire BOTH the legacy underscored event (for existing dashboards)
  // and the dotted event (required by the 2026-04 edit/delete launch).
  trackEvent("hr.employee_updated", updatedBy, userRole, {
    employee_id: id,
    department: row.department ?? "",
  });
  trackEvent("hr.employee.updated", updatedBy, userRole, {
    employee_id: id,
    department: row.department ?? "",
  });
  return row;
}

/**
 * deleteEmployee — hard delete. The table has no deleted_at column yet;
 * swap to UPDATE when it does. Fires `hr.employee_removed`. Returns true
 * when a row was removed.
 */
export async function deleteEmployee(
  id: string,
  deletedBy: string,
  userRole: string,
): Promise<boolean> {
  // RETURNING id so rows.length reflects whether the delete happened —
  // safeQuery doesn't surface pg's rowCount.
  const { rows } = await safeQuery<{ id: string }>(
    `DELETE FROM apex_employees WHERE id = $1 RETURNING id`,
    [id],
  );
  const affected = rows.length;
  if (affected > 0) {
    trackEvent("hr.employee_removed", deletedBy, userRole, { employee_id: id });
    trackEvent("hr.employee.deleted", deletedBy, userRole, { employee_id: id });
    return true;
  }
  return false;
}
