/**
 * Maintenance rails — intake telemetry.
 *
 * The agency files daily bug/feature requests as GitHub issues carrying the
 * `maint-queue` label (see .github/ISSUE_TEMPLATE/maintenance-*.yml). This
 * module maps one issue-lifecycle event (opened -> triaged -> resolved) into
 * the two existing durable signal sinks so no request is ever lost:
 *
 *   1. Analytics  — trackEvent() under the `maintenance.intake.*` namespace
 *      (src/lib/analytics.ts). Fire-and-forget; the learning/insights layer
 *      reads instinct_events to grade intake volume, category mix, and
 *      cycle time.
 *   2. Audit      — recordAudit() (src/lib/audit-log.ts), the append-only
 *      hash-chained compliance record: who/what/when for each lifecycle
 *      transition, tied to the issue as the resource.
 *
 * Derived signal: on `resolved` we compute cycle time (resolvedAt - openedAt)
 * once here, so the insights aggregator gets time-to-close for free without
 * re-deriving it from raw rows.
 *
 * No data lost / graceful degradation (matching the repo idiom, e.g.
 * feature-requests.ts and the platform.scan_persist_degraded signal):
 *   - trackEvent never throws (it swallows its own write errors internally).
 *   - recordAudit CAN throw. We catch it, keep the already-recorded analytics
 *     event, emit `maintenance.intake.telemetry_degraded`, and return a typed
 *     result with `degraded: true`. This function NEVER throws from a caller's
 *     perspective, so an issue-webhook handler can fire-and-forget it.
 *
 * This surface adds NO new table: it reuses instinct_events (analytics) and
 * instinct_audit_log (audit), so no migration is required.
 */

import { trackEvent, type InstinctEventType } from "@/lib/analytics";
import { recordAudit, type AuditActor } from "@/lib/audit-log";

export type MaintenanceRequestType = "bug" | "feature";
export type MaintenanceAction = "opened" | "triaged" | "resolved";

/**
 * One issue-lifecycle event. `openedAt` / `resolvedAt` are ISO-8601 strings
 * (the shape GitHub webhook payloads carry). `actor` is optional: lifecycle
 * transitions usually originate from an automation, so it defaults to a
 * system actor.
 */
export interface MaintenanceIntakeEvent {
  issueNumber: number;
  type: MaintenanceRequestType;
  /** Area/module the request targets (from the issue template's dropdown). */
  category: string;
  action: MaintenanceAction;
  openedAt: string;
  resolvedAt?: string;
  actor?: AuditActor;
}

/** Default actor when a lifecycle event has no human/agent attributed to it. */
export const SYSTEM_MAINTENANCE_ACTOR: AuditActor = {
  user_id: "system:maintenance-rails",
  role: "system",
};

/** Analytics metadata is constrained to primitives by trackEvent's signature. */
export type IntakeMetadata = Record<string, string | number | boolean>;

export interface IntakeAnalyticsPlan {
  event: InstinctEventType;
  metadata: IntakeMetadata;
}

export interface IntakeAuditPlan {
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  afterState: Record<string, unknown>;
}

export interface IntakeTelemetryPlan {
  analytics: IntakeAnalyticsPlan;
  audit: IntakeAuditPlan;
  /** Derived resolve signal in hours; null unless action === "resolved". */
  cycleTimeHours: number | null;
}

export interface IntakeTelemetryResult {
  /** true when both the analytics event AND the audit write succeeded. */
  ok: boolean;
  event: InstinctEventType;
  /** Audit chain seq on success; null when the audit write degraded. */
  auditSeq: number | null;
  /** true when the secondary audit write failed (analytics still recorded). */
  degraded: boolean;
  /** Populated on degrade — the audit error message (no secrets). */
  reason?: string;
  cycleTimeHours: number | null;
}

const RESOURCE_TYPE = "maintenance_request";

const ACTION_EVENT: Record<MaintenanceAction, InstinctEventType> = {
  opened: "maintenance.intake.opened",
  triaged: "maintenance.intake.triaged",
  resolved: "maintenance.intake.resolved",
};

/**
 * Cheap derived signal: cycle time between open and resolve. Returns null when
 * this is not a resolve transition, when `resolvedAt` is absent, when either
 * timestamp is unparseable, or when the result would be negative (clock skew /
 * bad payload) — a negative cycle time is never a valid learning signal.
 */
export function computeCycleTimeMs(event: MaintenanceIntakeEvent): number | null {
  if (event.action !== "resolved" || !event.resolvedAt) return null;
  const opened = Date.parse(event.openedAt);
  const resolved = Date.parse(event.resolvedAt);
  if (Number.isNaN(opened) || Number.isNaN(resolved)) return null;
  const delta = resolved - opened;
  return delta >= 0 ? delta : null;
}

/**
 * Pure mapping: turn a lifecycle event into the exact analytics + audit shapes
 * we will emit. Exported so the unit tests can assert the mapping without any
 * side effects (no DB, no mocks needed for the shape assertions).
 */
export function mapIntakeEvent(event: MaintenanceIntakeEvent): IntakeTelemetryPlan {
  const actor = event.actor ?? SYSTEM_MAINTENANCE_ACTOR;
  const analyticsEvent = ACTION_EVENT[event.action];

  const cycleTimeMs = computeCycleTimeMs(event);
  const cycleTimeHours =
    cycleTimeMs === null ? null : Math.round((cycleTimeMs / 3_600_000) * 100) / 100;

  const metadata: IntakeMetadata = {
    issue_number: event.issueNumber,
    type: event.type,
    category: event.category,
    action: event.action,
  };
  if (cycleTimeMs !== null && cycleTimeHours !== null) {
    metadata.cycle_time_ms = cycleTimeMs;
    metadata.cycle_time_hours = cycleTimeHours;
  }

  const afterState: Record<string, unknown> = {
    issue_number: event.issueNumber,
    type: event.type,
    category: event.category,
    action: event.action,
    opened_at: event.openedAt,
  };
  if (event.resolvedAt) afterState.resolved_at = event.resolvedAt;
  if (cycleTimeHours !== null) afterState.cycle_time_hours = cycleTimeHours;

  return {
    analytics: { event: analyticsEvent, metadata },
    audit: {
      actor,
      action: analyticsEvent, // same dotted name; audit shape mirrors analytics
      resourceType: RESOURCE_TYPE,
      resourceId: String(event.issueNumber),
      afterState,
    },
    cycleTimeHours,
  };
}

/**
 * Record one intake lifecycle event to analytics + audit. Never throws: an
 * audit-write failure degrades to analytics-only and is itself surfaced via
 * `maintenance.intake.telemetry_degraded`, so the intake signal is never lost
 * and the degraded path is visible to the learning loop.
 */
export async function recordIntakeTelemetry(
  event: MaintenanceIntakeEvent,
): Promise<IntakeTelemetryResult> {
  const plan = mapIntakeEvent(event);
  const actor = plan.audit.actor;

  // Primary signal — fire-and-forget, never throws.
  trackEvent(plan.analytics.event, actor.user_id, actor.role, plan.analytics.metadata);

  // Secondary signal — the append-only audit record. Wrapped so a failure
  // degrades gracefully instead of throwing from the caller.
  try {
    const res = await recordAudit({
      actor,
      action: plan.audit.action,
      resourceType: plan.audit.resourceType,
      resourceId: plan.audit.resourceId,
      afterState: plan.audit.afterState,
    });
    return {
      ok: true,
      event: plan.analytics.event,
      auditSeq: res.seq,
      degraded: false,
      cycleTimeHours: plan.cycleTimeHours,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // No data lost: analytics already captured the transition. Make the
    // degraded audit path observable rather than swallowing it silently.
    trackEvent(
      "maintenance.intake.telemetry_degraded",
      actor.user_id,
      actor.role,
      { issue_number: event.issueNumber, action: event.action, reason },
    );
    return {
      ok: false,
      event: plan.analytics.event,
      auditSeq: null,
      degraded: true,
      reason,
      cycleTimeHours: plan.cycleTimeHours,
    };
  }
}
