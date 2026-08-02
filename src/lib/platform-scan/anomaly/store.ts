/**
 * Persistence for the host baseline (migration 228).
 *
 * detect.ts is pure and takes the baseline as an argument. This is the only
 * place that argument comes from or goes back to, so the two rules that make the
 * baseline trustworthy live here rather than in every caller:
 *
 *   1. first_seen_at is written once and never overwritten. It is the answer to
 *      "when did this appear", which is the question an incident review asks,
 *      and it is unanswerable once it has been stamped over.
 *
 *   2. A scan that cannot be trusted does not become the new baseline. One
 *      failed run must not erase the history that makes novelty detectable at
 *      all. shouldPersistBaseline() states that rule; this enforces it.
 *
 * Every query filters workspace_id explicitly, per the repo-wide
 * tenant-isolation scan. A baseline that leaked across workspaces would mean one
 * client's normal traffic silently vouching for another client's anomaly.
 */
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { NetworkObservation } from "../network/observations";
import { foldBaseline, shouldPersistBaseline, type AnomalyReport, type HostBaseline } from "./detect";

interface BaselineRow extends Record<string, unknown> {
  host: string;
  first_seen_at: string;
  last_seen_at: string;
  scan_count: number;
}

/**
 * What we have seen this target contact before.
 *
 * Returns undefined when this target has NEVER been scanned, and an empty array
 * when it has been scanned and saw nothing. detect.ts reads the difference: only
 * the second case can say a host is new.
 */
export async function readBaseline(workspaceId: string, targetId: string): Promise<HostBaseline[] | undefined> {
  const runs = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM instinct_scan_anomaly_runs
      WHERE workspace_id = $1 AND target_id = $2 AND baseline_updated = TRUE`,
    [workspaceId, targetId],
  );
  if (Number(runs.rows[0]?.n ?? 0) === 0) return undefined;

  const res = await query<BaselineRow>(
    `SELECT host, first_seen_at, last_seen_at, scan_count
       FROM instinct_scan_host_baseline
      WHERE workspace_id = $1 AND target_id = $2
      ORDER BY host`,
    [workspaceId, targetId],
  );
  return res.rows.map((r) => ({
    host: r.host,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
    scanCount: Number(r.scan_count),
  }));
}

/**
 * Record a scan, and update the baseline if this scan earned the right to.
 *
 * Returns whether the baseline moved, so the caller can tell a client "we are
 * now watching for changes against this" versus "this run was not good enough
 * to learn from". Both are honest; only one is progress.
 */
export async function recordAnomalyRun(args: {
  workspaceId: string;
  targetId: string;
  pageUrl: string;
  report: AnomalyReport;
  observations: NetworkObservation[];
  pageLoaded?: boolean;
  actor?: { userId: string; role: string };
}): Promise<{ runId: string; baselineUpdated: boolean }> {
  const { workspaceId, targetId, pageUrl, report, observations } = args;
  const trustworthy = shouldPersistBaseline({ pageLoaded: args.pageLoaded, observations });

  const inserted = await query<{ id: string }>(
    `INSERT INTO instinct_scan_anomaly_runs
       (workspace_id, target_id, page_url, report, third_parties, unexplained, novel, baseline_updated, caveats)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      workspaceId,
      targetId,
      pageUrl,
      JSON.stringify(report),
      report.totals.thirdParties,
      report.totals.unexplained,
      report.totals.novel,
      trustworthy,
      JSON.stringify(report.caveats),
    ],
  );
  const runId = inserted.rows[0].id;

  if (trustworthy) {
    const nowIso = new Date().toISOString();
    for (const b of foldBaseline([], observations, nowIso)) {
      // first_seen_at is deliberately absent from the UPDATE list. The whole
      // value of the baseline is that it remembers when something appeared.
      await query(
        `INSERT INTO instinct_scan_host_baseline (workspace_id, target_id, host, first_seen_at, last_seen_at, scan_count)
         VALUES ($1, $2, $3, $4, $4, 1)
         ON CONFLICT (workspace_id, target_id, host) DO UPDATE
            SET last_seen_at = EXCLUDED.last_seen_at,
                scan_count   = instinct_scan_host_baseline.scan_count + 1`,
        [workspaceId, targetId, b.host, nowIso],
      );
    }
  }

  const actor = args.actor ?? { userId: "system", role: "system" };
  trackEvent("platform.anomaly_run_completed", actor.userId, actor.role, {
    workspace_id: workspaceId,
    target_id: targetId,
    run_id: runId,
    third_parties: report.totals.thirdParties,
    unexplained: report.totals.unexplained,
    novel: report.totals.novel,
    baseline_updated: trustworthy,
    caveat_count: report.caveats.length,
  });

  // One event per unexplained host, so the learning loop can answer "which
  // vendors keep turning up unannounced across our whole client base" without
  // re-reading every stored report. A single roll-up event could not.
  for (const f of report.findings.filter((x) => !x.explainedBy)) {
    trackEvent("platform.unexplained_host_detected", actor.userId, actor.role, {
      workspace_id: workspaceId,
      target_id: targetId,
      run_id: runId,
      host: f.host,
      vendor: f.vendor ?? "unrecognised",
      kind: f.kind,
      severity: f.severity,
      novelty: f.novelty,
      before_consent: f.evidence.beforeConsent,
      with_credentials: f.evidence.withCredentials,
    });
  }

  return { runId, baselineUpdated: trustworthy };
}

export interface StoredAnomalyRun extends Record<string, unknown> {
  id: string;
  page_url: string;
  report: AnomalyReport;
  third_parties: number;
  unexplained: number;
  novel: number;
  baseline_updated: boolean;
  created_at: string;
}

/** Recent runs for a target, newest first. Includes runs that did not update the
 *  baseline: a gap in coverage should be visible, not look like a clean stretch. */
export async function listAnomalyRuns(workspaceId: string, targetId: string, limit = 20): Promise<StoredAnomalyRun[]> {
  const res = await query<StoredAnomalyRun>(
    `SELECT id, page_url, report, third_parties, unexplained, novel, baseline_updated, created_at
       FROM instinct_scan_anomaly_runs
      WHERE workspace_id = $1 AND target_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [workspaceId, targetId, Math.min(Math.max(1, limit), 100)],
  );
  return res.rows;
}
