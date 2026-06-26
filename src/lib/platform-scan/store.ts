/**
 * Platform-scan persistence + learning tie-in.
 *
 * recordScan writes the scan run header + each finding, emits analytics per
 * finding and on completion, and feeds a Brain summary of every finding (so the
 * findings are retrievable semantically). listFindings + triageFinding back the
 * review UI. Mirrors the drift store (src/lib/agents/drift/store.ts) and the
 * approvals store: one row per durable fact, every state change emits an event.
 *
 * No data lost: the scan run, every finding, the analytics stream, AND the Brain
 * summary all persist from a single scan.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { notify } from "@/lib/notifications/in-app";
import { ingestPlatformScanFinding } from "./brain-ingest";
import type { PlatformScanResult, ScanSeverity, ScanCategory } from "./types";

export interface ScanFindingRow {
  id: string;
  scanId: string;
  platform: string;
  route: string;
  severity: ScanSeverity;
  category: ScanCategory;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
}

type DbRow = Record<string, unknown>;

function toFinding(r: DbRow): ScanFindingRow {
  return {
    id: String(r.id),
    scanId: String(r.scan_id),
    platform: String(r.platform),
    route: String(r.route),
    severity: String(r.severity) as ScanSeverity,
    category: String(r.category) as ScanCategory,
    title: String(r.title),
    detail: String(r.detail ?? ""),
    evidence: (r.evidence ?? {}) as Record<string, unknown>,
    status: String(r.status) as ScanFindingRow["status"],
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export interface RecordScanInput {
  workspaceId: string;
  actorId: string;
  actorRole: string;
  result: PlatformScanResult;
}

/** Persist a completed scan + its findings, emitting analytics + Brain summaries.
 *  Returns the scan id and counts. */
export async function recordScan(
  input: RecordScanInput,
): Promise<{ scanId: string; findingCount: number; criticalCount: number }> {
  const { workspaceId, actorId, actorRole, result } = input;
  const criticalCount = result.findings.filter((f) => f.severity === "critical").length;

  const scanRes = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_platform_scans
       (workspace_id, platform, base_url, route_count, finding_count, critical_count, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [workspaceId, result.platform, result.baseUrl, result.routeCount, result.findings.length, criticalCount, actorId],
  );
  const scanId = scanRes.rows[0].id;

  for (const f of result.findings) {
    await writeQuery(
      `INSERT INTO instinct_platform_scan_findings
         (scan_id, workspace_id, platform, route, severity, category, title, detail, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [scanId, workspaceId, result.platform, f.route, f.severity, f.category, f.title, f.detail, JSON.stringify(f.evidence)],
    );
    trackEvent("platform.scan_finding_detected", actorId, actorRole, {
      platform: result.platform,
      route: f.route,
      severity: f.severity,
      category: f.category,
    });
    // Learning: feed a human-readable summary into the Brain (best effort).
    await ingestPlatformScanFinding(result.platform, f);
  }

  trackEvent("platform.scan_completed", actorId, actorRole, {
    platform: result.platform,
    route_count: result.routeCount,
    finding_count: result.findings.length,
    critical_count: criticalCount,
  });

  // HUMAN ALERTING: a critical finding is a security event a human must see, not
  // an analytics row nobody watches. Notify the workspace admin/owner who ran the
  // scan (actorId), mirroring the drift store's auto-pause notify idiom. The
  // notification row IS the persisted learning signal (notify persists + emits
  // system.notification_created). Best effort: a notify failure must never break
  // the scan that was just persisted.
  if (criticalCount > 0) {
    try {
      await notify({
        userId: actorId,
        category: "security",
        priority: "high",
        title: `Critical scan finding on ${result.platform}`,
        body: `The platform scan of ${result.platform} found ${criticalCount} critical ${
          criticalCount === 1 ? "issue" : "issues"
        }. Review and triage before they reach clients.`,
        actionUrl: "/admin/platform-scans",
        actionLabel: "Review scan findings",
        source: "platform_scan",
        sourceId: scanId,
        metadata: {
          scan_id: scanId,
          platform: result.platform,
          critical_count: criticalCount,
          finding_count: result.findings.length,
        },
        dedup: true,
      });
    } catch {
      /* notification is best effort; the scan + findings already stand */
    }
  }

  return { scanId, findingCount: result.findings.length, criticalCount };
}

/** Open (or any-status) findings for the workspace, worst severity first. */
export async function listFindings(
  workspaceId: string,
  opts?: { status?: ScanFindingRow["status"]; platform?: string; limit?: number },
): Promise<ScanFindingRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, scan_id, platform, route, severity, category, title, detail, evidence, status, created_at
       FROM instinct_platform_scan_findings
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR platform = $3)
      ORDER BY CASE severity
                 WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                 WHEN 'medium' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT $4`,
    [workspaceId, opts?.status ?? null, opts?.platform ?? null, limit],
  );
  return rows.map(toFinding);
}

export interface FindingsSummary {
  total: number;
  bySeverity: Record<ScanSeverity, number>;
  byCategory: Record<string, number>;
}

/** Counts of OPEN findings for the workspace, broken out by severity + category.
 *  Optional platform filter. Degrades to all-zero counts with no DB (safeQuery). */
export async function summarizeFindings(
  workspaceId: string,
  platform?: string,
): Promise<FindingsSummary> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT severity, category, COUNT(*)::int AS n
       FROM instinct_platform_scan_findings
      WHERE workspace_id = $1
        AND status = 'open'
        AND ($2::text IS NULL OR platform = $2)
      GROUP BY severity, category`,
    [workspaceId, platform ?? null],
  );
  const bySeverity: Record<ScanSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    const sev = String(r.severity) as ScanSeverity;
    const cat = String(r.category);
    if (sev in bySeverity) bySeverity[sev] += n;
    byCategory[cat] = (byCategory[cat] ?? 0) + n;
    total += n;
  }
  return { total, bySeverity, byCategory };
}

export interface ScanRow {
  id: string;
  platform: string;
  baseUrl: string;
  routeCount: number;
  findingCount: number;
  criticalCount: number;
  createdAt: string;
}

/** Recent scan runs for the workspace, newest first. Default limit 10, cap 50. */
export async function listScans(
  workspaceId: string,
  limit?: number,
): Promise<ScanRow[]> {
  const lim = Math.min(Math.max(limit ?? 10, 1), 50);
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, platform, base_url, route_count, finding_count, critical_count, created_at
       FROM instinct_platform_scans
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [workspaceId, lim],
  );
  return rows.map((r) => ({
    id: String(r.id),
    platform: String(r.platform),
    baseUrl: String(r.base_url ?? ""),
    routeCount: Number(r.route_count) || 0,
    findingCount: Number(r.finding_count) || 0,
    criticalCount: Number(r.critical_count) || 0,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/** Move a finding through the review workflow (acknowledge / resolve). Atomic;
 *  returns the updated row or null if not found. Emits a triage event. */
export async function triageFinding(
  id: string,
  workspaceId: string,
  status: "acknowledged" | "resolved",
  decidedBy: string,
  decidedByRole: string,
): Promise<ScanFindingRow | null> {
  const { rows } = await writeQuery<DbRow>(
    `UPDATE instinct_platform_scan_findings
        SET status = $3, decided_by = $4, decided_at = now()
      WHERE id = $1 AND workspace_id = $2
      RETURNING id, scan_id, platform, route, severity, category, title, detail, evidence, status, created_at`,
    [id, workspaceId, status, decidedBy],
  );
  if (!rows[0]) return null;
  const finding = toFinding(rows[0]);
  trackEvent("platform.scan_finding_triaged", decidedBy, decidedByRole, {
    platform: finding.platform,
    route: finding.route,
    severity: finding.severity,
    status,
  });
  return finding;
}
