/**
 * Read persisted factory runs for the history + grading surface.
 *
 * Each pipeline run emits an `ai_code.pipeline_run` analytics event (see the
 * pipeline route). This reads them back, workspace-scoped, and maps them to the
 * PipelineRunRecord shape the grader/drift detector consume. No new table: the
 * event stream is already the durable record.
 */
import { safeQuery } from "@/lib/db";
import type { PipelineRunRecord } from "./grading";

export interface RunSummary {
  ref: string;
  model: string;
  /** Per-run failure taxonomy for model-capability grading. Optional: runs
   *  recorded before it shipped omit these (read as clean). */
  selfHealed?: boolean;
  handedOff?: boolean;
  mode?: string;
  costUsd?: number;
  phantomImports?: number;
  brokenLocalImports?: number;
  incompleteFiles?: number;
  removedExports?: number;
  anchorFailures?: number;
  /** The target repo this run built against; null for the self-hosted
   *  (apex/Instinct) executor default. Absent for runs recorded before per-site
   *  attribution shipped - those surface as "unattributed". */
  repo?: string | null;
  status: "ready_for_pr" | "needs_human";
  attempts: number;
  finalOutcome: "allow" | "escalate" | "block";
  deepScanCritical: number;
  conforms: boolean;
  createdAt: string;
  /** The actual code change (unified diff) this run produced, so the history UI
   *  can show what was built - not just its grade. Capped at authoring time;
   *  `diffTruncated` flags when the stored diff was cut. Absent for runs recorded
   *  before diffs were persisted. */
  diff?: string;
  diffTruncated?: boolean;
  /** The gate verdict's reason, so a history row explains WHY it was graded. */
  reason?: string;
}

interface EventRow {
  metadata: Record<string, unknown> | string;
  timestamp: string;
}

function asObj(m: EventRow["metadata"]): Record<string, unknown> {
  if (typeof m === "string") {
    try { return JSON.parse(m) as Record<string, unknown>; } catch { return {}; }
  }
  return m ?? {};
}

const asStatus = (v: unknown): RunSummary["status"] =>
  v === "needs_human" ? "needs_human" : "ready_for_pr";
const asOutcome = (v: unknown): RunSummary["finalOutcome"] =>
  v === "block" ? "block" : v === "escalate" ? "escalate" : "allow";
const asNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Recent runs for a workspace, newest first. Reads the pipeline_run event stream
 * filtered by the workspace_id carried in the event metadata, so it is
 * tenant-scoped. NEVER throws (safeQuery); returns [] on any read failure.
 */
export async function listPipelineRuns(
  workspaceId: string,
  limit = 50,
  /** Optional per-site filter: only runs whose target repo matches. Runs
   *  recorded before per-site attribution (no repo in metadata) are excluded
   *  from a repo filter, included when unfiltered. */
  repo?: string,
): Promise<RunSummary[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const repoFilter = repo && repo.trim() ? repo.trim() : null;
  const { rows } = await safeQuery<EventRow>(
    `SELECT metadata, timestamp::text AS timestamp
       FROM instinct_events
      WHERE event_type = 'ai_code.pipeline_run'
        AND metadata->>'workspace_id' = $1
        ${repoFilter ? "AND metadata->>'repo' = $2" : ''}
      ORDER BY timestamp DESC
      LIMIT ${lim}`,
    repoFilter ? [workspaceId, repoFilter] : [workspaceId],
  );
  return rows.map((r) => {
    const m = asObj(r.metadata);
    return {
      ref: typeof m.ref === "string" ? m.ref : "(unknown)",
      model: typeof m.model === "string" ? m.model : "(unknown)",
      status: asStatus(m.status),
      attempts: asNum(m.attempts),
      finalOutcome: asOutcome(m.final_outcome),
      deepScanCritical: asNum(m.deep_scan_critical),
      conforms: m.conforms === true || m.conforms === "true",
      createdAt: r.timestamp,
      repo: typeof m.repo === "string" ? m.repo : null,
      // Per-run failure taxonomy (added for model-capability grading). Absent on
      // runs recorded before it shipped; those read as 0 / undefined (clean).
      selfHealed: m.self_healed === true || m.self_healed === "true",
      handedOff: m.handed_off === true || m.handed_off === "true",
      mode: typeof m.mode === "string" ? m.mode : undefined,
      costUsd: asNum(m.cost_usd),
      phantomImports: asNum(m.phantom_imports),
      brokenLocalImports: asNum(m.broken_local_imports),
      incompleteFiles: asNum(m.incomplete_files),
      removedExports: asNum(m.removed_exports),
      anchorFailures: asNum(m.anchor_failures),
      ...(typeof m.diff === "string" && m.diff.length > 0 ? { diff: m.diff } : {}),
      ...(m.diff_truncated === true || m.diff_truncated === "true" ? { diffTruncated: true } : {}),
      ...(typeof m.verdict_reason === "string" && m.verdict_reason.length > 0 ? { reason: m.verdict_reason } : {}),
    };
  });
}

/** Map run summaries (newest-first) to grader records (oldest-first, with ts). */
export function toRunRecords(runs: readonly RunSummary[]): PipelineRunRecord[] {
  return [...runs]
    .reverse()
    .map((r) => ({
      model: r.model,
      status: r.status,
      attempts: r.attempts,
      finalOutcome: r.finalOutcome,
      deepScanCritical: r.deepScanCritical,
      selfHealed: r.selfHealed,
      costUsd: r.costUsd,
      phantomImports: r.phantomImports,
      brokenLocalImports: r.brokenLocalImports,
      incompleteFiles: r.incompleteFiles,
      removedExports: r.removedExports,
      anchorFailures: r.anchorFailures,
      ts: Date.parse(r.createdAt) || undefined,
    }));
}

/**
 * The distinct set of target repos the workspace's runs have built against,
 * newest-activity first, so the history UI can offer a per-site selector.
 * null (self-hosted default) surfaces as the literal "(self)" so it is a
 * selectable, stable key. NEVER throws.
 */
export async function listRunRepos(workspaceId: string): Promise<string[]> {
  const { rows } = await safeQuery<{ repo: string | null }>(
    `SELECT DISTINCT metadata->>'repo' AS repo
       FROM instinct_events
      WHERE event_type = 'ai_code.pipeline_run'
        AND metadata->>'workspace_id' = $1`,
    [workspaceId],
  );
  return rows.map((r) => r.repo ?? "(self)").sort((a, b) => a.localeCompare(b));
}
