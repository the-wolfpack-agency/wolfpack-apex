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

import { safeQuery, writeQuery, withTransaction } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { notify } from "@/lib/notifications/in-app";
import { ingestPlatformScanFinding } from "./brain-ingest";
import type { PlatformScanResult, ScanCoverage, ScanSeverity, ScanCategory } from "./types";

/** Coverage at or above this ratio is "thorough enough" to trust a clean result.
 *  Below it, too much of the target went unscanned to call 0 findings clean. */
export const MIN_TRUSTWORTHY_COVERAGE = 0.8;

/**
 * A scan is DEGRADED - and a 0-findings result therefore NOT a clean bill - when:
 *   - any route errored (network/timeout/5xx: we never saw its behavior), OR
 *   - auth was required but the session was not established (login-gated routes
 *     unreachable), OR
 *   - the fraction of routes we actually reached fell below the trust threshold.
 * Pure + exported so the rule is unit-testable and reused by the UI shape.
 */
export function isCoverageDegraded(c: ScanCoverage): boolean {
  return (
    c.errored > 0 ||
    (c.authRequired && !c.authEstablished) ||
    c.coverageRatio < MIN_TRUSTWORTHY_COVERAGE
  );
}

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
): Promise<{ scanId: string; findingCount: number; criticalCount: number; autoResolvedCount: number }> {
  const { workspaceId, actorId, actorRole, result } = input;
  const criticalCount = result.findings.filter((f) => f.severity === "critical").length;
  // Coverage may be absent on external-ingest results (no routes probed). Persist
  // NULLs in that case so a missing signal is never mistaken for "fully covered".
  const cov = result.coverage;

  // ATOMIC PERSISTENCE: the scan header, every finding upsert, and the
  // auto-resolve UPDATE are ONE unit of work. A mid-loop failure used to leave an
  // orphaned header + partial findings committed while the caller (and the ingest
  // route) were told findingCount:0 - the worst data-loss shape: a silent partial
  // write reported as a clean zero. Wrapping in a single transaction makes it
  // all-or-nothing: any write failure ROLLs BACK and re-throws so the caller sees
  // an error (and, in ingest, retries) instead of dropping the only copy of the
  // findings. expectRows:1 on the header + each upsert surfaces a 0-row write
  // (RLS-discarded / view-swallowed) as an error rather than a false success.
  const persisted = await withTransaction(async (tx) => {
    const scanRes = await tx.write<{ id: string }>(
      `INSERT INTO instinct_platform_scans
         (workspace_id, platform, base_url, route_count, finding_count, critical_count, triggered_by,
          attempted_routes, succeeded_routes, errored_routes, auth_established, coverage_ratio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        workspaceId, result.platform, result.baseUrl, result.routeCount, result.findings.length, criticalCount, actorId,
        cov ? cov.attempted : 0,
        cov ? cov.succeeded : 0,
        cov ? cov.errored : 0,
        cov ? cov.authEstablished : null,
        cov ? cov.coverageRatio : null,
      ],
      { expectRows: 1 },
    );
    const sid = scanRes.rows[0].id;

    for (const f of result.findings) {
      // Identity = (workspace, platform, route, title). A re-scan UPDATES the
      // existing finding (refreshes severity/evidence + which scan last saw it)
      // instead of inserting a duplicate; human triage (status/decided_*) and the
      // original created_at are preserved. This is what stops the findings list
      // from piling up across runs. RETURNING id + expectRows:1 turns a write the
      // DB silently discarded (RLS/policy) into an error instead of a false success.
      await tx.write(
        `INSERT INTO instinct_platform_scan_findings
           (scan_id, workspace_id, platform, route, severity, category, title, detail, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (workspace_id, platform, route, title) DO UPDATE SET
           scan_id = EXCLUDED.scan_id,
           severity = EXCLUDED.severity,
           category = EXCLUDED.category,
           detail = EXCLUDED.detail,
           evidence = EXCLUDED.evidence
         RETURNING id`,
        [sid, workspaceId, result.platform, f.route, f.severity, f.category, f.title, f.detail, JSON.stringify(f.evidence)],
        { expectRows: 1 },
      );
    }

    // AUTO-RESOLVE (inside the SAME transaction so a failure rolls the whole scan
    // back too): close the find -> fix -> re-scan loop. When a scan covers a route
    // (scannedRoutes) but no longer reports a finding it previously had open on
    // that route, the underlying bug was fixed: mark it resolved. Without this,
    // every fixed bug lingers as a stale "open" row and the findings list never
    // shrinks even as the target improves. Scoping by `route = ANY(scannedRoutes)`
    // keeps modalities from stepping on each other: an HTTP scan (route = URL path)
    // never touches a static finding (route = file path). Omitting scannedRoutes
    // (external ingest) skips this: we must not resolve findings the run did not
    // actually re-check. No expectRows here: resolving 0 stale findings is valid.
    let resolvedCount = 0;
    if (result.scannedRoutes && result.scannedRoutes.length > 0) {
      const SEP = "\x1f"; // unit separator, safe: never appears in a route/title
      const foundKeys = result.findings.map((f) => `${f.route}${SEP}${f.title}`);
      const resolved = await tx.write<{ id: string }>(
        `UPDATE instinct_platform_scan_findings
            SET status = 'resolved', decided_by = $4, decided_at = now()
          WHERE workspace_id = $1
            AND platform = $2
            AND status = 'open'
            AND route = ANY($3::text[])
            AND (route || $5 || title) <> ALL($6::text[])
          RETURNING id`,
        [workspaceId, result.platform, result.scannedRoutes, "auto:rescan", SEP, foundKeys],
      );
      resolvedCount = resolved.rows.length;
    }

    return { scanId: sid, autoResolvedCount: resolvedCount };
  });
  const scanId = persisted.scanId;
  const autoResolvedCount = persisted.autoResolvedCount;

  // POST-COMMIT side effects: only run once the scan + findings are durably
  // committed. Analytics + Brain ingest (a network call we must not hold a DB
  // connection across) fire here so a side-effect failure never rolls back
  // persisted data, and persisted data is never claimed before COMMIT.
  for (const f of result.findings) {
    trackEvent("platform.scan_finding_detected", actorId, actorRole, {
      platform: result.platform,
      route: f.route,
      severity: f.severity,
      category: f.category,
    });
    // Learning: feed a human-readable summary into the Brain (best effort).
    await ingestPlatformScanFinding(result.platform, f);
  }

  // AUTO-RESOLVE analytics (post-commit): the UPDATE itself ran inside the
  // transaction above; fire the aggregate learning signal only once the resolve
  // is durably committed. One aggregate signal, not per-row: a per-row event
  // would flood the stream and break the "one row per durable fact" idiom
  // (mirrors bulkTriageFindings).
  if (autoResolvedCount > 0) {
    trackEvent("platform.scan_findings_auto_resolved", actorId, actorRole, {
      platform: result.platform,
      count: autoResolvedCount,
      scan_id: scanId,
    });
  }

  trackEvent("platform.scan_completed", actorId, actorRole, {
    platform: result.platform,
    route_count: result.routeCount,
    finding_count: result.findings.length,
    critical_count: criticalCount,
  });

  // COVERAGE LEARNING SIGNAL: when the scan could not fully cover the target, a
  // 0-findings result is NOT a clean bill. Fire the degraded event so the learning
  // loop records flaky/unscannable targets and the report can warn instead of
  // claiming "secure". No data lost: every degraded run is captured, not silently
  // dropped. Only fires when coverage exists (the engine probed routes) AND the
  // degraded rule trips - a fully-covered scan stays silent.
  if (cov && isCoverageDegraded(cov)) {
    trackEvent("platform.scan_coverage_degraded", actorId, actorRole, {
      platform: result.platform,
      attempted: cov.attempted,
      succeeded: cov.succeeded,
      errored: cov.errored,
      auth_ok: cov.authEstablished,
    });
  }

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

  return { scanId, findingCount: result.findings.length, criticalCount, autoResolvedCount };
}

/** Open (or any-status) findings for the workspace, worst severity first.
 *  `severities` narrows to a subset (e.g. ["critical","high"]) so the review UI
 *  can default to the ACTIONABLE band without losing the lower-severity rows —
 *  omit it (or pass empty) and every severity is returned, unchanged. */
export async function listFindings(
  workspaceId: string,
  opts?: { status?: ScanFindingRow["status"]; platform?: string; severities?: ScanSeverity[]; limit?: number },
): Promise<ScanFindingRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
  const severities = opts?.severities && opts.severities.length > 0 ? opts.severities : null;
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, scan_id, platform, route, severity, category, title, detail, evidence, status, created_at
       FROM instinct_platform_scan_findings
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR platform = $3)
        AND ($4::text[] IS NULL OR severity = ANY($4))
      ORDER BY CASE severity
                 WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                 WHEN 'medium' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT $5`,
    [workspaceId, opts?.status ?? null, opts?.platform ?? null, severities, limit],
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
  /** Per-run coverage. Null when the run predates coverage accounting OR was an
   *  external ingest that did not probe routes - the UI treats "unknown" as a
   *  reason NOT to claim a clean bill, never as "fully covered". */
  coverage: ScanCoverage | null;
  /** Convenience: did this run fail the trust threshold? Null when coverage is
   *  unknown. Computed server-side so every consumer applies the SAME rule. */
  degraded: boolean | null;
}

/** Recent scan runs for the workspace, newest first. Default limit 10, cap 50. */
export async function listScans(
  workspaceId: string,
  limit?: number,
): Promise<ScanRow[]> {
  const lim = Math.min(Math.max(limit ?? 10, 1), 50);
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, platform, base_url, route_count, finding_count, critical_count, created_at,
            attempted_routes, succeeded_routes, errored_routes, auth_established, coverage_ratio
       FROM instinct_platform_scans
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [workspaceId, lim],
  );
  return rows.map((r) => {
    // Coverage is "known" only when the run recorded an attempt count (>0). A run
    // that predates coverage accounting (NULL ratio) or probed nothing reads as
    // unknown - never as fully covered.
    const attempted = Number(r.attempted_routes) || 0;
    const known = r.coverage_ratio !== null && r.coverage_ratio !== undefined && attempted > 0;
    // We persist auth_established (true/false) but not auth_required as its own
    // column. The only auth-driven degradation is "auth was required but NOT
    // established", which is exactly auth_established === false. So derive
    // authRequired := (auth_established === false): when established is false the
    // run had a gated target it could not reach; when true/null there is nothing
    // to warn about on the auth axis. This keeps isCoverageDegraded faithful
    // without a second column.
    const authEstablished = r.auth_established !== false;
    const coverage: ScanCoverage | null = known
      ? {
          attempted,
          succeeded: Number(r.succeeded_routes) || 0,
          errored: Number(r.errored_routes) || 0,
          authRequired: r.auth_established === false,
          authEstablished,
          coverageRatio: Number(r.coverage_ratio) || 0,
        }
      : null;
    return {
      id: String(r.id),
      platform: String(r.platform),
      baseUrl: String(r.base_url ?? ""),
      routeCount: Number(r.route_count) || 0,
      findingCount: Number(r.finding_count) || 0,
      criticalCount: Number(r.critical_count) || 0,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      coverage,
      degraded: coverage ? isCoverageDegraded(coverage) : null,
    };
  });
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

/** Triage EVERY currently-open finding matching the active filter in a single
 *  UPDATE — the bulk counterpart to triageFinding, backing the "Acknowledge /
 *  Resolve all shown" actions. Only OPEN rows move (already-decided findings are
 *  left untouched). `severities`/`platform` mirror the listFindings filter so the
 *  action triages exactly what the reviewer is looking at, nothing hidden. Emits
 *  ONE bulk event (not one per row) and returns how many findings moved. */
export async function bulkTriageFindings(
  workspaceId: string,
  opts: { status: "acknowledged" | "resolved"; severities?: ScanSeverity[]; platform?: string },
  decidedBy: string,
  decidedByRole: string,
): Promise<number> {
  const severities = opts.severities && opts.severities.length > 0 ? opts.severities : null;
  const { rows } = await writeQuery<DbRow>(
    `UPDATE instinct_platform_scan_findings
        SET status = $3, decided_by = $4, decided_at = now()
      WHERE workspace_id = $1
        AND status = 'open'
        AND ($2::text IS NULL OR platform = $2)
        AND ($5::text[] IS NULL OR severity = ANY($5))
      RETURNING id`,
    [workspaceId, opts.platform ?? null, opts.status, decidedBy, severities],
  );
  const count = rows.length;
  // One aggregate learning signal for the whole batch — a per-row event would
  // flood the stream and break the "one row per durable fact" idiom.
  trackEvent("platform.scan_findings_bulk_triaged", decidedBy, decidedByRole, {
    status: opts.status,
    count,
    // Analytics metadata is scalar-only — record the band as a stable csv.
    severities: severities ? severities.join(",") : "all",
    platform: opts.platform ?? "all",
  });
  return count;
}
