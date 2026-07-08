/**
 * Maintenance intake telemetry — unit + contract tests.
 *
 * Two layers, mirroring the repo's existing sibling tests:
 *   - Unit: the pure mapping (mapIntakeEvent / computeCycleTimeMs) with no
 *     side effects — cycle-time derivation, action->event mapping, actor
 *     defaulting.
 *   - Contract: recordIntakeTelemetry emits the exact analytics event + audit
 *     entry shapes, and degrades gracefully (never throws) when the audit
 *     write fails. Analytics + audit are mocked the same way feature-requests
 *     and the discussions route tests mock them.
 *
 * There is NO UI surface in this increment, so there is no UI/E2E test here.
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

import {
  mapIntakeEvent,
  computeCycleTimeMs,
  recordIntakeTelemetry,
  SYSTEM_MAINTENANCE_ACTOR,
  type MaintenanceIntakeEvent,
} from "@/lib/maintenance/intake-telemetry";

const OPENED_AT = "2026-07-08T09:00:00.000Z";
const RESOLVED_AT = "2026-07-08T15:30:00.000Z"; // +6.5h

function baseEvent(overrides: Partial<MaintenanceIntakeEvent> = {}): MaintenanceIntakeEvent {
  return {
    issueNumber: 42,
    type: "bug",
    category: "assistant",
    action: "opened",
    openedAt: OPENED_AT,
    ...overrides,
  };
}

describe("computeCycleTimeMs (derived signal)", () => {
  it("returns null for non-resolve actions", () => {
    expect(computeCycleTimeMs(baseEvent({ action: "opened" }))).toBeNull();
    expect(computeCycleTimeMs(baseEvent({ action: "triaged" }))).toBeNull();
  });

  it("returns null on resolve without resolvedAt", () => {
    expect(computeCycleTimeMs(baseEvent({ action: "resolved" }))).toBeNull();
  });

  it("computes the open->resolve delta in ms", () => {
    const ms = computeCycleTimeMs(baseEvent({ action: "resolved", resolvedAt: RESOLVED_AT }));
    expect(ms).toBe(6.5 * 3_600_000);
  });

  it("returns null for unparseable timestamps", () => {
    expect(
      computeCycleTimeMs(baseEvent({ action: "resolved", openedAt: "not-a-date", resolvedAt: RESOLVED_AT })),
    ).toBeNull();
  });

  it("returns null for negative deltas (clock skew / bad payload)", () => {
    expect(
      computeCycleTimeMs(baseEvent({ action: "resolved", openedAt: RESOLVED_AT, resolvedAt: OPENED_AT })),
    ).toBeNull();
  });
});

describe("mapIntakeEvent (pure mapping)", () => {
  it("maps each action to its maintenance.intake.* event", () => {
    expect(mapIntakeEvent(baseEvent({ action: "opened" })).analytics.event).toBe("maintenance.intake.opened");
    expect(mapIntakeEvent(baseEvent({ action: "triaged" })).analytics.event).toBe("maintenance.intake.triaged");
    expect(mapIntakeEvent(baseEvent({ action: "resolved", resolvedAt: RESOLVED_AT })).analytics.event).toBe(
      "maintenance.intake.resolved",
    );
  });

  it("builds analytics metadata with primitives only and no cycle time pre-resolve", () => {
    const { analytics } = mapIntakeEvent(baseEvent({ action: "triaged" }));
    expect(analytics.metadata).toEqual({
      issue_number: 42,
      type: "bug",
      category: "assistant",
      action: "triaged",
    });
    for (const v of Object.values(analytics.metadata)) {
      expect(["string", "number", "boolean"]).toContain(typeof v);
    }
  });

  it("includes cycle_time_ms + cycle_time_hours in metadata on resolve", () => {
    const { analytics, cycleTimeHours } = mapIntakeEvent(
      baseEvent({ type: "feature", action: "resolved", resolvedAt: RESOLVED_AT }),
    );
    expect(analytics.metadata.cycle_time_ms).toBe(6.5 * 3_600_000);
    expect(analytics.metadata.cycle_time_hours).toBe(6.5);
    expect(cycleTimeHours).toBe(6.5);
  });

  it("produces an audit plan scoped to the issue as the resource", () => {
    const { audit } = mapIntakeEvent(baseEvent({ issueNumber: 99, action: "resolved", resolvedAt: RESOLVED_AT }));
    expect(audit.action).toBe("maintenance.intake.resolved");
    expect(audit.resourceType).toBe("maintenance_request");
    expect(audit.resourceId).toBe("99");
    expect(audit.afterState).toMatchObject({
      issue_number: 99,
      type: "bug",
      category: "assistant",
      action: "resolved",
      opened_at: OPENED_AT,
      resolved_at: RESOLVED_AT,
      cycle_time_hours: 6.5,
    });
  });

  it("defaults to the system actor when none is supplied", () => {
    expect(mapIntakeEvent(baseEvent()).audit.actor).toEqual(SYSTEM_MAINTENANCE_ACTOR);
  });

  it("honors an explicit actor", () => {
    const actor = { user_id: "user-7", role: "admin" };
    expect(mapIntakeEvent(baseEvent({ actor })).audit.actor).toEqual(actor);
  });
});

describe("recordIntakeTelemetry (contract)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordAudit.mockResolvedValue({ id: "audit-1", seq: 101, entryHash: "hash" });
  });

  it("emits the analytics event with the mapped namespace + metadata", async () => {
    await recordIntakeTelemetry(baseEvent({ action: "opened" }));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "maintenance.intake.opened",
      SYSTEM_MAINTENANCE_ACTOR.user_id,
      SYSTEM_MAINTENANCE_ACTOR.role,
      { issue_number: 42, type: "bug", category: "assistant", action: "opened" },
    );
  });

  it("writes an audit entry with the exact AuditEntryInput shape", async () => {
    await recordIntakeTelemetry(baseEvent({ issueNumber: 7, action: "resolved", resolvedAt: RESOLVED_AT }));
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith({
      actor: SYSTEM_MAINTENANCE_ACTOR,
      action: "maintenance.intake.resolved",
      resourceType: "maintenance_request",
      resourceId: "7",
      afterState: expect.objectContaining({
        issue_number: 7,
        action: "resolved",
        cycle_time_hours: 6.5,
      }),
    });
  });

  it("returns ok with the audit seq on success", async () => {
    const res = await recordIntakeTelemetry(baseEvent({ action: "resolved", resolvedAt: RESOLVED_AT }));
    expect(res).toMatchObject({
      ok: true,
      event: "maintenance.intake.resolved",
      auditSeq: 101,
      degraded: false,
      cycleTimeHours: 6.5,
    });
  });

  it("degrades gracefully (no throw) when the audit write fails, keeping analytics", async () => {
    mockRecordAudit.mockRejectedValueOnce(new Error("chain locked"));
    const res = await recordIntakeTelemetry(baseEvent({ action: "triaged" }));

    // Never throws; typed degraded result.
    expect(res).toMatchObject({ ok: false, degraded: true, auditSeq: null, reason: "chain locked" });

    // Primary intake signal still recorded, plus the degraded meta-event.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "maintenance.intake.triaged",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ issue_number: 42, action: "triaged" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "maintenance.intake.telemetry_degraded",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ issue_number: 42, action: "triaged", reason: "chain locked" }),
    );
  });

  it("attributes the audit entry to an explicit actor when supplied", async () => {
    const actor = { user_id: "user-3", role: "member" };
    await recordIntakeTelemetry(baseEvent({ action: "opened", actor }));
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ actor }));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "maintenance.intake.opened",
      "user-3",
      "member",
      expect.any(Object),
    );
  });
});
