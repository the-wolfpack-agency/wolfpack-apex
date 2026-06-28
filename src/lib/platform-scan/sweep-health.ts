/**
 * Sweep health: make continuous-sweep failures VISIBLE.
 *
 * THE PROBLEM this fixes. Both cron sweeps (engagement-sweep, pentest-sweep) keep
 * a client's security posture fresh by re-scanning on a schedule. Each sweep
 * iterates a list of targets; the orchestrators already catch a single target's
 * throw and encode it as a per-target result with `skipped: "error:<msg>"`. But
 * the cron ROUTE was blind to that: it counted an errored target as merely "not
 * assessed" and never alerted, and a top-level throw (e.g. the target list query
 * failing) returned a silent zeroed 200 so the cron monitor stayed green. Net
 * effect: a silently-broken sweep let a client's posture go stale with NO alert.
 *
 * THE FIX. This module is the observability + alerting layer the routes wrap
 * around their sweep call. It:
 *   (a) records ONE run row per sweep tick in instinct_sweep_runs (migration 198)
 *       - the durable health ledger, no data lost about sweep health;
 *   (b) captures PER-TARGET outcome so one failing target never silently vanishes
 *       (its reason is recorded in the run's `details`);
 *   (c) derives status: ok / partial / failed;
 *   (d) on partial-or-failed, alerts the operator via the EXISTING notifications
 *       layer (notify(), the same mechanism recordScan uses for critical findings
 *       - we do NOT build a new notifier) and fires platform.sweep_failed; on a
 *       clean run fires platform.sweep_completed.
 *
 * RESILIENCE. runSweepWithHealth wraps the whole sweep call in try/catch so a
 * top-level orchestrator throw becomes a recorded + alerted `failed` run instead
 * of a silent zeroed 200. The per-target resilience already lives in the
 * orchestrators (one target's throw -> `skipped:"error:..."`, sweep continues);
 * this layer surfaces those encoded failures and the total-throw case alike.
 *
 * ALERT / DEDUP DESIGN (compared options, choice justified):
 *   - email-on-every-failure: simplest, but a persistently-broken target would
 *     spam the operator every cron tick (e.g. every 15 min, forever) -> alert
 *     fatigue -> the alert gets muted -> we are back to silent failure. Rejected.
 *   - digest (batch failures, send once a day): low noise, but a broken sweep
 *     could go unnoticed for up to a day. Posture-staleness is exactly what we
 *     are trying to surface FAST, so a slow digest defeats the purpose. Rejected.
 *   - status-change dedup (CHOSEN): alert on EVERY transition INTO an unhealthy
 *     state, i.e. when this run's status (partial|failed) differs from the
 *     previous run's status for the same kind. A run that stays broken across
 *     consecutive ticks does NOT re-alert, so no spam; the moment it breaks (or
 *     RE-breaks after a recovery) the operator is alerted immediately. We still
 *     record EVERY run row and fire platform.sweep_failed on EVERY unhealthy run
 *     (analytics must see the full signal for the learning loop) - only the
 *     human-facing email/notification is deduped. notify(dedup:true) is a second
 *     safety net against same-tick duplicates.
 *
 * Every external dependency is injectable so tests never touch a real DB, send a
 * real email, or write a real analytics row.
 */

import { randomUUID } from "crypto";
import { safeQuery } from "@/lib/db";
import { notify } from "@/lib/notifications/in-app";
import { trackEvent, type InstinctEventType } from "@/lib/analytics";

export type SweepKind = "engagement" | "pentest" | "ux";
export type SweepStatus = "ok" | "partial" | "failed";

/** Outcome of one target within a sweep. `reason` is set only on failure. */
export interface TargetOutcome {
  target: string;
  ok: boolean;
  reason?: string;
}

/** Who to alert when a sweep is unhealthy. Mirrors recordScan: the operator who
 *  the sweep runs as (cron actor id, or the manual sweeper). */
export interface SweepActor {
  id: string;
  role: string;
}

export interface SweepRunRecord {
  id: string;
  kind: SweepKind;
  startedAt: string;
  finishedAt: string;
  targetsTotal: number;
  targetsSucceeded: number;
  targetsFailed: number;
  status: SweepStatus;
  error: string | null;
  outcomes: TargetOutcome[];
}

// ---------------------------------------------------------------------------
// Injectable dependencies (real ones by default; overridden in tests)
// ---------------------------------------------------------------------------

export interface SweepHealthDeps {
  /** Insert one sweep-run row. */
  insertRun: (row: SweepRunRecord) => Promise<void>;
  /** Read the previous run's status for this kind (for status-change dedup). */
  previousStatus: (kind: SweepKind) => Promise<SweepStatus | null>;
  /** Send the human-facing alert (existing notifications layer). */
  notify: typeof notify;
  /** Emit an analytics event. */
  trackEvent: typeof trackEvent;
  /** Clock + id, injectable so tests are deterministic. */
  now: () => Date;
  newId: () => string;
}

/** Real persistence: write to instinct_sweep_runs (migration 198). */
async function realInsertRun(row: SweepRunRecord): Promise<void> {
  await safeQuery(
    `INSERT INTO instinct_sweep_runs
       (id, kind, started_at, finished_at, targets_total, targets_succeeded,
        targets_failed, status, error, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      row.id,
      row.kind,
      row.startedAt,
      row.finishedAt,
      row.targetsTotal,
      row.targetsSucceeded,
      row.targetsFailed,
      row.status,
      row.error,
      JSON.stringify({
        outcomes: row.outcomes,
        targets_total: row.targetsTotal,
        targets_succeeded: row.targetsSucceeded,
        targets_failed: row.targetsFailed,
      }),
    ],
  );
}

/** Real previous-status read: latest prior run for this kind. */
async function realPreviousStatus(kind: SweepKind): Promise<SweepStatus | null> {
  const { rows } = await safeQuery<{ status: SweepStatus }>(
    `SELECT status FROM instinct_sweep_runs
      WHERE kind = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [kind],
  );
  return rows.length > 0 ? rows[0].status : null;
}

export const defaultSweepHealthDeps: SweepHealthDeps = {
  insertRun: realInsertRun,
  previousStatus: realPreviousStatus,
  notify,
  trackEvent,
  now: () => new Date(),
  newId: () => `swp_${randomUUID()}`,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Decide the run status from the per-target tally.
 *   failed  -> attempted targets > 0 and ALL failed, OR a top-level throw
 *              (succeeded === 0 && failed === 0 && hadError) means nothing ran.
 *   partial -> at least one failed AND at least one succeeded.
 *   ok      -> no failures.
 * A run with zero targets and no error is `ok` (nothing was due; not a failure).
 */
export function decideStatus(
  succeeded: number,
  failed: number,
  hadTopLevelError: boolean,
): SweepStatus {
  if (hadTopLevelError) return "failed";
  if (failed === 0) return "ok";
  if (succeeded === 0) return "failed";
  return "partial";
}

const QUERIED_EVENT_BY_STATUS: Record<Exclude<SweepStatus, "ok">, InstinctEventType> = {
  partial: "platform.sweep_failed",
  failed: "platform.sweep_failed",
};

// ---------------------------------------------------------------------------
// recordSweepRun: persist + decide + alert + analytics
// ---------------------------------------------------------------------------

export interface RecordSweepInput {
  kind: SweepKind;
  actor: SweepActor;
  startedAt: Date;
  outcomes: TargetOutcome[];
  /** Set when the sweep itself threw before/while producing outcomes. */
  topLevelError?: string | null;
}

export interface RecordSweepResult {
  runId: string;
  status: SweepStatus;
  targetsTotal: number;
  targetsSucceeded: number;
  targetsFailed: number;
  alerted: boolean;
}

/**
 * Record one sweep run: insert the ledger row, derive status, fire analytics
 * (every run), and alert the operator on a transition INTO an unhealthy state
 * (status-change dedup). Never throws - every step is best-effort so the cron's
 * "never 500" contract holds even if the DB or notifier is down.
 */
export async function recordSweepRun(
  input: RecordSweepInput,
  deps: SweepHealthDeps = defaultSweepHealthDeps,
): Promise<RecordSweepResult> {
  const succeeded = input.outcomes.filter((o) => o.ok).length;
  const failed = input.outcomes.filter((o) => !o.ok).length;
  const hadError = Boolean(input.topLevelError);
  const status = decideStatus(succeeded, failed, hadError);

  const runId = deps.newId();
  const finishedAt = deps.now().toISOString();
  const total = input.outcomes.length;

  const record: SweepRunRecord = {
    id: runId,
    kind: input.kind,
    startedAt: input.startedAt.toISOString(),
    finishedAt,
    targetsTotal: total,
    targetsSucceeded: succeeded,
    targetsFailed: failed,
    status,
    error: input.topLevelError ?? null,
    outcomes: input.outcomes,
  };

  // (a) Durable health ledger row. Best-effort: a write failure must not break
  //     the cron, but it is logged so the failure-to-record is itself visible.
  try {
    await deps.insertRun(record);
  } catch (err) {
    console.warn(`[sweep-health] failed to record ${input.kind} run:`, (err as Error).message);
  }

  // (d) Analytics on EVERY run - the learning loop must see the full signal.
  try {
    if (status === "ok") {
      deps.trackEvent("platform.sweep_completed", input.actor.id, input.actor.role, {
        kind: input.kind,
        targets: total,
        succeeded,
        failed,
      });
    } else {
      deps.trackEvent(QUERIED_EVENT_BY_STATUS[status], input.actor.id, input.actor.role, {
        kind: input.kind,
        targets: total,
        succeeded,
        failed,
        status,
      });
    }
  } catch (err) {
    console.warn(`[sweep-health] analytics failed for ${input.kind}:`, (err as Error).message);
  }

  // Human-facing alert: only on a TRANSITION into an unhealthy state, so a
  // persistently-broken sweep does not spam every cron tick. See the file
  // header for the rejected alternatives (every-failure / digest).
  let alerted = false;
  if (status !== "ok") {
    let prev: SweepStatus | null = null;
    try {
      prev = await deps.previousStatus(input.kind);
    } catch {
      // If we cannot read the prior status, fail OPEN and alert: a missed alert
      // on a real failure is worse than one extra notification.
      prev = null;
    }
    if (prev !== status) {
      alerted = await sendSweepAlert(record, input.actor, deps);
    }
  }

  return {
    runId,
    status,
    targetsTotal: total,
    targetsSucceeded: succeeded,
    targetsFailed: failed,
    alerted,
  };
}

/** Send the operator alert through the existing notifications layer. Best-effort. */
async function sendSweepAlert(
  record: SweepRunRecord,
  actor: SweepActor,
  deps: SweepHealthDeps,
): Promise<boolean> {
  const failedTargets = record.outcomes
    .filter((o) => !o.ok)
    .map((o) => o.target)
    .slice(0, 5);
  // Label derives from the kind so a new kind (e.g. "ux") reads correctly
  // without a hardcoded 2-way branch that would mislabel it.
  const label = `${record.kind} sweep`;
  const body =
    record.status === "failed"
      ? record.error
        ? `The continuous ${label} FAILED to run: ${record.error}. The client's security posture is going stale - investigate now.`
        : `The continuous ${label} FAILED: all ${record.targetsFailed} target(s) errored. The client's security posture is going stale - investigate now.`
      : `The continuous ${label} ran PARTIALLY: ${record.targetsFailed} of ${record.targetsTotal} target(s) failed${
          failedTargets.length > 0 ? ` (${failedTargets.join(", ")})` : ""
        }. Those targets' posture is stale - investigate.`;

  try {
    await deps.notify({
      userId: actor.id,
      category: "security",
      priority: "high",
      title: `Continuous ${label} ${record.status === "failed" ? "failed" : "ran partially"}`,
      body,
      actionUrl: "/admin/platform-scans",
      actionLabel: "Review sweep health",
      source: "sweep_health",
      sourceId: `${record.kind}:${record.status}`,
      metadata: {
        run_id: record.id,
        kind: record.kind,
        status: record.status,
        targets_total: record.targetsTotal,
        targets_failed: record.targetsFailed,
        failed_targets: failedTargets.join(", "),
      },
      // sourceId is kind:status (not the run id) so dedup collapses repeated
      // same-state alerts within the notification layer too - belt and braces
      // alongside the status-change gate above.
      dedup: true,
    });
    return true;
  } catch (err) {
    console.warn(`[sweep-health] alert failed for ${record.kind}:`, (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// runSweepWithHealth: the wrapper the cron routes use
// ---------------------------------------------------------------------------

export interface SweepExecution<R> {
  /** The raw per-target results the orchestrator returned. */
  results: R[];
  /** Map one result to its outcome (success or failure + reason). */
  outcome: (result: R) => TargetOutcome;
}

export interface RunSweepWithHealthInput<R> {
  kind: SweepKind;
  actor: SweepActor;
  /** Runs the underlying sweep. May throw - we catch and record a failed run. */
  run: () => Promise<R[]>;
  /** Maps one raw result to its target outcome. */
  outcome: (result: R) => TargetOutcome;
}

export interface RunSweepWithHealthResult<R> {
  /** Raw results, or [] if the sweep threw at the top level. */
  results: R[];
  health: RecordSweepResult;
}

/**
 * Run a sweep and record its health. This is what the cron routes call instead
 * of invoking the orchestrator directly.
 *
 * - On success: every result is classified per-target, the run is recorded, and
 *   it alerts only if some target failed (status-change deduped).
 * - On a top-level throw (the orchestrator itself failed before producing
 *   results): records a `failed` run with the error, alerts, and returns [].
 *   The caller still returns a 200 - but the failure is now VISIBLE.
 */
export async function runSweepWithHealth<R>(
  input: RunSweepWithHealthInput<R>,
  deps: SweepHealthDeps = defaultSweepHealthDeps,
): Promise<RunSweepWithHealthResult<R>> {
  const startedAt = deps.now();
  let results: R[] = [];
  let topLevelError: string | null = null;
  try {
    results = await input.run();
  } catch (err) {
    topLevelError = (err as Error)?.message ?? "unknown error";
    console.error(`[sweep-health] ${input.kind} sweep threw:`, topLevelError);
  }

  const outcomes = results.map(input.outcome);
  const health = await recordSweepRun(
    { kind: input.kind, actor: input.actor, startedAt, outcomes, topLevelError },
    deps,
  );

  return { results, health };
}

/**
 * Classify an engagement per-target result. The orchestrator encodes a target
 * that threw as `skipped: "error:<msg>"`; a legitimate non-failure skip (no
 * static target) is NOT a failure. Anything else assessed is a success.
 */
export function engagementOutcome(r: {
  platform: string;
  skipped?: string;
}): TargetOutcome {
  if (r.skipped && r.skipped.startsWith("error:")) {
    return { target: r.platform, ok: false, reason: r.skipped };
  }
  return { target: r.platform, ok: true, reason: r.skipped };
}

/** Classify a pentest per-target result. Same error-encoding contract. */
export function pentestOutcome(r: { platform: string; skipped?: string }): TargetOutcome {
  if (r.skipped && r.skipped.startsWith("error:")) {
    return { target: r.platform, ok: false, reason: r.skipped };
  }
  return { target: r.platform, ok: true, reason: r.skipped };
}

/** Direct ledger reader for the health page / tests. */
export async function listRecentSweepRuns(
  kind?: SweepKind,
  limit = 20,
): Promise<SweepRunRecord[]> {
  const params: unknown[] = [];
  let where = "";
  if (kind) {
    where = "WHERE kind = $1";
    params.push(kind);
  }
  params.push(limit);
  const { rows } = await safeQuery<{
    id: string;
    kind: SweepKind;
    started_at: string;
    finished_at: string | null;
    targets_total: number;
    targets_succeeded: number;
    targets_failed: number;
    status: SweepStatus;
    error: string | null;
    details: { outcomes?: TargetOutcome[] } | null;
  }>(
    `SELECT id, kind, started_at, finished_at, targets_total, targets_succeeded,
            targets_failed, status, error, details
       FROM instinct_sweep_runs
       ${where}
      ORDER BY started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    startedAt: typeof r.started_at === "string" ? r.started_at : new Date(r.started_at).toISOString(),
    finishedAt:
      r.finished_at == null
        ? ""
        : typeof r.finished_at === "string"
          ? r.finished_at
          : new Date(r.finished_at).toISOString(),
    targetsTotal: Number(r.targets_total) || 0,
    targetsSucceeded: Number(r.targets_succeeded) || 0,
    targetsFailed: Number(r.targets_failed) || 0,
    status: r.status,
    error: r.error,
    outcomes: r.details?.outcomes ?? [],
  }));
}
