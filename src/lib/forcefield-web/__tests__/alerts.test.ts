/**
 * Forcefield-web alerting: dedupe per incident + window (never forever), the
 * recorded delivery outcome (a failure is recorded and retried, never
 * swallowed), Graph email + in-app delivery, and the daily silence check.
 */
const mockFanout = jest.fn();
const mockSendViaGraph = jest.fn();
const mockTrackAwait = jest.fn();
jest.mock("@/lib/notifications/team-fanout", () => ({ fanoutToTeam: (...a: unknown[]) => mockFanout(...a) }));
jest.mock("@/lib/mail/send-via-graph", () => ({ sendViaGraph: (...a: unknown[]) => mockSendViaGraph(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: (...a: unknown[]) => mockTrackAwait(...a), trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));

import {
  scanForcefieldWebAlerts,
  runAlertSilenceCheck,
  deliverForcefieldAlert,
  dispatchForcefieldAlert,
  incidentKey,
  windowStartOf,
  isSilenceCheckHour,
  MAX_ATTEMPTS,
  type ForcefieldAlert,
  type ForcefieldAlertDeps,
  type HostileSignal,
  type DeliveryOutcome,
} from "../alerts";

const OK: DeliveryOutcome = { status: "delivered", inAppRecipients: 1, emailAttempted: 1, emailDelivered: 1, detail: "" };
const FAIL: DeliveryOutcome = { status: "failed", inAppRecipients: 0, emailAttempted: 1, emailDelivered: 0, detail: "email:no_mail_from" };

/** An in-memory alert store with the SAME claim semantics as the SQL: a new key
 *  inserts; a delivered key never re-claims; a failed key re-claims until
 *  MAX_ATTEMPTS. */
function memoryDeps(signals: HostileSignal[], opts: { outcome?: DeliveryOutcome; hostile?: number } = {}) {
  const rows = new Map<string, { status: string | null; attempts: number; kind: string }>();
  const sent: ForcefieldAlert[] = [];
  const tracked: { event: string; payload: Record<string, unknown> }[] = [];
  const deps: ForcefieldAlertDeps = {
    listHostileSignals: async () => signals,
    claimAlert: async (a) => {
      const k = `${a.kind}:${a.dedupeKey}`;
      const r = rows.get(k);
      if (!r) { rows.set(k, { status: null, attempts: 1, kind: a.kind }); return true; }
      if (r.status === "failed" && r.attempts < MAX_ATTEMPTS) { r.attempts++; return true; }
      return false;
    },
    deliver: async (a) => { sent.push(a); return opts.outcome ?? OK; },
    recordOutcome: async (a, o) => { rows.get(`${a.kind}:${a.dedupeKey}`)!.status = o.status; },
    track: async (event, payload) => { tracked.push({ event, payload }); },
    countHostileEvents: async () => opts.hostile ?? signals.reduce((n, s) => n + s.count, 0),
    countDeliveredAlerts: async () => [...rows.values()].filter((r) => r.status === "delivered" && r.kind !== "alert_silence").length,
  };
  return { deps, rows, sent, tracked };
}

function sig(over: Partial<HostileSignal> = {}): HostileSignal {
  return { kind: "payload_attack", site: "ogiam.com", attackClass: "sql_injection", windowStart: "2026-10-24T12:00:00.000Z", fpCount: 0, samplePath: "/?q=1", count: 3, ...over };
}

beforeEach(() => jest.clearAllMocks());

describe("dedupe per incident and window", () => {
  it("alerts a NEW incident and records forcefield.web_alert_dispatched with the outcome", async () => {
    const m = memoryDeps([sig()]);
    const r = await scanForcefieldWebAlerts(m.deps);
    expect(r).toEqual({ detected: 1, dispatched: 1, delivered: 1, failed: 0 });
    expect(m.sent[0].title).toMatch(/sql injection attack on ogiam\.com/);
    const ev = m.tracked.find((t) => t.event === "forcefield.web_alert_dispatched")!;
    expect(ev.payload.outcome).toBe("delivered");
    expect(ev.payload.site).toBe("ogiam.com");
    expect(ev.payload.attack_class).toBe("sql_injection");
  });

  it("does NOT re-alert a duplicate inside the same window", async () => {
    const m = memoryDeps([sig()]);
    await scanForcefieldWebAlerts(m.deps);
    const again = await scanForcefieldWebAlerts(m.deps);
    expect(again.dispatched).toBe(0);
    expect(m.sent).toHaveLength(1);
  });

  it("DOES alert a second distinct incident after the window (the old forever-dedupe bug)", async () => {
    const first = sig({ windowStart: "2026-10-24T06:00:00.000Z" });
    const later = sig({ windowStart: "2026-10-24T12:00:00.000Z" });
    const m = memoryDeps([first]);
    await scanForcefieldWebAlerts(m.deps);
    m.deps.listHostileSignals = async () => [first, later];
    const r = await scanForcefieldWebAlerts(m.deps);
    expect(r.dispatched).toBe(1);
    expect(m.sent).toHaveLength(2);
  });

  it("a different attack class on the same site in the same window is its own incident", async () => {
    const m = memoryDeps([sig(), sig({ attackClass: "xss" })]);
    expect((await scanForcefieldWebAlerts(m.deps)).dispatched).toBe(2);
  });

  it("does not depend on the fingerprint (almost every event has none)", () => {
    const k = incidentKey("payload_attack", "ogiam.com", "xss", "2026-10-24T12:00:00.000Z");
    expect(k).toBe(incidentKey("payload_attack", "ogiam.com", "xss", "2026-10-24T12:00:00.000Z"));
    expect(k).not.toBe(incidentKey("payload_attack", "ogiam.com", "xss", "2026-10-24T18:00:00.000Z"));
    expect(k).not.toBe(incidentKey("payload_attack", "instinct", "xss", "2026-10-24T12:00:00.000Z"));
  });

  it("windowStartOf aligns to fixed 6-hour windows", () => {
    expect(windowStartOf(new Date("2026-10-24T13:59:00Z"))).toBe("2026-10-24T12:00:00.000Z");
    expect(windowStartOf(new Date("2026-10-24T18:00:00Z"))).toBe("2026-10-24T18:00:00.000Z");
  });
});

describe("delivery failures are recorded, never swallowed", () => {
  it("records outcome=failed with the reason and counts it as failed", async () => {
    const m = memoryDeps([sig()], { outcome: FAIL });
    const r = await scanForcefieldWebAlerts(m.deps);
    expect(r).toEqual({ detected: 1, dispatched: 1, delivered: 0, failed: 1 });
    const ev = m.tracked.find((t) => t.event === "forcefield.web_alert_dispatched")!;
    expect(ev.payload.outcome).toBe("failed");
    expect(ev.payload.detail).toBe("email:no_mail_from");
  });

  it("retries a failed alert on the next scan, up to MAX_ATTEMPTS", async () => {
    const m = memoryDeps([sig()], { outcome: FAIL });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await scanForcefieldWebAlerts(m.deps);
    expect(m.sent).toHaveLength(MAX_ATTEMPTS);
  });

  it("a deliver that throws is recorded as failed", async () => {
    const m = memoryDeps([]);
    m.deps.deliver = async () => { throw new Error("boom"); };
    const out = await dispatchForcefieldAlert({ kind: "canary_trip", dedupeKey: "k1", title: "t", body: "b" }, m.deps);
    expect(out?.status).toBe("failed");
    expect(out?.detail).toMatch(/boom/);
  });
});

describe("silence check", () => {
  it("fires when hostile events exist but no alert reached anyone", async () => {
    const m = memoryDeps([], { hostile: 42 });
    const r = await runAlertSilenceCheck(m.deps, new Date("2026-10-24T12:05:00Z"));
    expect(r.silent).toBe(true);
    expect(r.alert?.status).toBe("delivered");
    expect(m.sent[0].kind).toBe("alert_silence");
    expect(m.tracked.map((t) => t.event)).toContain("forcefield.alert_silence_detected");
  });

  it("does not fire when an alert was delivered in the window", async () => {
    const m = memoryDeps([sig()]);
    await scanForcefieldWebAlerts(m.deps);
    const r = await runAlertSilenceCheck(m.deps);
    expect(r.silent).toBe(false);
    expect(m.sent.filter((a) => a.kind === "alert_silence")).toHaveLength(0);
  });

  it("fires when every scan alert FAILED to deliver (a broken mailer is silence too)", async () => {
    const m = memoryDeps([sig()], { outcome: FAIL });
    await scanForcefieldWebAlerts(m.deps);
    expect((await runAlertSilenceCheck(m.deps)).silent).toBe(true);
  });

  it("does not fire with no hostile traffic", async () => {
    const m = memoryDeps([], { hostile: 0 });
    expect((await runAlertSilenceCheck(m.deps)).silent).toBe(false);
    expect(m.sent).toHaveLength(0);
  });

  it("raises at most one silence alert per UTC day", async () => {
    const m = memoryDeps([], { hostile: 5 });
    await runAlertSilenceCheck(m.deps, new Date("2026-10-24T12:00:00Z"));
    await runAlertSilenceCheck(m.deps, new Date("2026-10-24T12:50:00Z"));
    expect(m.sent).toHaveLength(1);
    await runAlertSilenceCheck(m.deps, new Date("2026-10-25T12:00:00Z"));
    expect(m.sent).toHaveLength(2);
  });

  it("runs during the 12:00 UTC hour only", () => {
    expect(isSilenceCheckHour(new Date("2026-10-24T12:40:00Z"))).toBe(true);
    expect(isSilenceCheckHour(new Date("2026-10-24T13:00:00Z"))).toBe(false);
  });
});

describe("deliverForcefieldAlert (in-app + Graph email)", () => {
  const ALERT: ForcefieldAlert = { kind: "payload_attack", dedupeKey: "abc", title: "Forcefield: x", body: "<b>body</b>", site: "s" };

  it("delivers in-app to the security owner only and emails through Graph", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 1, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    const o = await deliverForcefieldAlert(ALERT);
    expect(o).toMatchObject({ status: "delivered", inAppRecipients: 1, emailAttempted: 1, emailDelivered: 1 });
    const input = mockFanout.mock.calls[0][0];
    expect(input.recipientEmails).toEqual(["homyk@thewolfpack.agency"]);
    expect(input.sourceId).toBe("abc");
    expect(input.category).toBe("security");
    const mail = mockSendViaGraph.mock.calls[0][0];
    expect(mail.to).toBe("homyk@thewolfpack.agency");
    expect(mail.html).not.toContain("<b>"); // body is escaped
  });

  it("is delivered when only one channel works", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 0, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    expect((await deliverForcefieldAlert(ALERT)).status).toBe("delivered");
  });

  it("is FAILED with the reasons when nothing went out", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 0, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: false, reason: "scope_missing" });
    const o = await deliverForcefieldAlert(ALERT);
    expect(o.status).toBe("failed");
    expect(o.detail).toContain("in_app:no_recipient");
    expect(o.detail).toContain("email:scope_missing");
  });

  it("never throws when a channel throws", async () => {
    mockFanout.mockRejectedValue(new Error("db down"));
    mockSendViaGraph.mockRejectedValue(new Error("network"));
    const o = await deliverForcefieldAlert(ALERT);
    expect(o.status).toBe("failed");
  });
});
