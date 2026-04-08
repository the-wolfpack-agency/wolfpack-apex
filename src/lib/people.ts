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
