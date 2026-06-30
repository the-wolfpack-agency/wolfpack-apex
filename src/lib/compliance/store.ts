/**
 * Compliance report store (instinct_compliance_reports, migration 214).
 * Workspace-scoped, best-effort persistence (the report is already returned to
 * the caller; the row is the durable evidence + the coverage time series).
 */
import { createHash } from "node:crypto";
import { safeQuery } from "@/lib/db";
import type { ComplianceReport } from "./types";

export interface ComplianceReportRecord {
  id: string;
  framework: string;
  coverage: number;
  covered: number;
  partial: number;
  gap: number;
  createdAt: string;
}

interface DbRow {
  id: string;
  framework: string;
  coverage: number;
  covered: number;
  partial: number;
  gap: number;
  created_at: string;
}

export async function recordReport(workspaceId: string, report: ComplianceReport, nowIso: string): Promise<string> {
  const id = `cmp_${createHash("sha256").update([workspaceId, report.framework, nowIso].join(" ")).digest("hex").slice(0, 24)}`;
  await safeQuery(
    `INSERT INTO instinct_compliance_reports
       (id, workspace_id, framework, coverage, covered, partial, gap, report, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (id) DO NOTHING`,
    [id, workspaceId, report.framework, report.coverage, report.covered, report.partial, report.gap, JSON.stringify(report), nowIso],
  );
  return id;
}

/** The full stored report plus its identity, workspace-scoped. The export
 *  signs THIS, so it must be fetched by (id, workspaceId) - never id alone, so
 *  one workspace can never sign/export another workspace's report (no IDOR). */
export interface StoredComplianceReport {
  id: string;
  workspaceId: string;
  framework: string;
  report: ComplianceReport;
  createdAt: string;
}

export async function getReportById(
  workspaceId: string,
  id: string,
): Promise<StoredComplianceReport | null> {
  const res = await safeQuery<{
    id: string;
    workspace_id: string;
    framework: string;
    report: unknown;
    created_at: string;
  }>(
    `SELECT id, workspace_id, framework, report, created_at::text AS created_at
       FROM instinct_compliance_reports
      WHERE workspace_id = $1 AND id = $2
      LIMIT 1`,
    [workspaceId, id],
  );
  const r = res.rows[0];
  if (!r) return null;
  // The `report` JSONB column round-trips as an object (pg) or a string (some
  // drivers); normalize so callers always get a ComplianceReport.
  const report = (typeof r.report === "string" ? JSON.parse(r.report) : r.report) as ComplianceReport;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    framework: r.framework,
    report,
    createdAt: r.created_at,
  };
}

export async function listReports(workspaceId: string, limit = 100): Promise<ComplianceReportRecord[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const res = await safeQuery<DbRow>(
    `SELECT id, framework, coverage, covered, partial, gap, created_at::text AS created_at
       FROM instinct_compliance_reports
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT ${lim}`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    framework: r.framework,
    coverage: Number(r.coverage),
    covered: r.covered,
    partial: r.partial,
    gap: r.gap,
    createdAt: r.created_at,
  }));
}
