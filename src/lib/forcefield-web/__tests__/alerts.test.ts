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
const mockSafeQuery = jest.fn<Promise<{ rows: unknown[] }>, unknown[]>(async () => ({ rows: [] }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import {
  scanForcefieldWebAlerts,
  runAlertSilenceCheck,
  deliverForcefieldAlert,
  dispatchForcefieldAlert,
  incidentKey,
  windowStartOf,
  isSilenceCheckHour,
  fingerprintPhrase,
  liveForcefieldAlertDeps,
  signalFromRow,
  lookupBlockDecision,
  alertRowId,
  EXCLUDE_SYNTHETIC_SQL,
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
    expect(m.sent[0].title).toBe("[Forcefield] ogiam.com: SQL injection detected (3 attempts)");
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

describe("alert wording: fingerprints", () => {
  it("says 'fingerprint not recorded' when no event in the group carried one", async () => {
    const m = memoryDeps([sig({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", count: 2, fpCount: 0, samplePath: "/_ff/records" })]);
    await scanForcefieldWebAlerts(m.deps);
    const body = m.sent[0].body;
    expect(body).toContain("2 honeytoken trips on ogiam.com");
    expect(body).toContain("Fingerprint not recorded.");
    expect(body).not.toMatch(/0 distinct fingerprint/);
    expect(body).toContain("Example path: /_ff/records.");
  });

  it("gives the distinct count when fingerprints were recorded, singular and plural", async () => {
    const one = memoryDeps([sig({ count: 1, fpCount: 1 })]);
    await scanForcefieldWebAlerts(one.deps);
    expect(one.sent[0].body).toContain("1 payload attack on ogiam.com");
    expect(one.sent[0].body).toContain("1 distinct fingerprint.");
    const many = memoryDeps([sig({ count: 5, fpCount: 3 })]);
    await scanForcefieldWebAlerts(many.deps);
    expect(many.sent[0].body).toContain("5 payload attacks on ogiam.com");
    expect(many.sent[0].body).toContain("3 distinct fingerprints.");
  });

  it("fingerprintPhrase treats 0, negative and NaN as not recorded", () => {
    expect(fingerprintPhrase(0)).toBe("Fingerprint not recorded");
    expect(fingerprintPhrase(-1)).toBe("Fingerprint not recorded");
    expect(fingerprintPhrase(Number.NaN)).toBe("Fingerprint not recorded");
    expect(fingerprintPhrase(2)).toBe("2 distinct fingerprints");
  });

  it("the new wording is still HTML-escaped in the email", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 1, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    const m = memoryDeps([sig({ samplePath: "/<script>x</script>", fpCount: 0 })]);
    m.deps.deliver = deliverForcefieldAlert;
    await scanForcefieldWebAlerts(m.deps);
    const mail = mockSendViaGraph.mock.calls[0][0];
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("Fingerprint not recorded");
  });
});

describe("our own synthetic probes never raise an alert", () => {
  const sqlOf = (i: number) => String(mockSafeQuery.mock.calls[i][0]);

  it("the hostile-signal scan excludes events stamped props.synthetic", async () => {
    await liveForcefieldAlertDeps().listHostileSignals(24);
    const sql = sqlOf(0);
    expect(sql).toContain(EXCLUDE_SYNTHETIC_SQL);
    expect(EXCLUDE_SYNTHETIC_SQL).toMatch(/props->>'synthetic'/);
    // Fingerprints: empty strings are not a recorded fingerprint.
    expect(sql).toContain("count(DISTINCT NULLIF(props->>'fp', ''))");
  });

  it("the silence check's hostile count excludes them too (no false silence alert)", async () => {
    await liveForcefieldAlertDeps().countHostileEvents(24);
    expect(sqlOf(0)).toContain(EXCLUDE_SYNTHETIC_SQL);
  });

  it("the exemption keys on the token-attested mark only, never the user agent", async () => {
    await liveForcefieldAlertDeps().listHostileSignals(24);
    await liveForcefieldAlertDeps().countHostileEvents(24);
    for (const i of [0, 1]) {
      expect(sqlOf(i)).not.toMatch(/user.?agent|wolfpack-verify|props->>'ua'/i);
      // A signed-in (authenticated but not synthetic) attacker still alerts.
      expect(sqlOf(i)).not.toMatch(/props->>'authenticated'/);
    }
  });
});

/* ------------------------- the incident email path ------------------------- */

/** A grouped row exactly as the incident SQL returns it (synthetic ids). */
const ROW = {
  kind: "site.agent_trap_tripped", site: "ogiam.com", attack: "site.agent_trap_tripped",
  window_start: new Date("2026-10-26T06:00:00.000Z"), fps: "1", sample: "/_ff/records", count: "1",
  first_at: new Date("2026-10-26T10:05:37.367Z"), last_at: new Date("2026-10-26T10:05:37.367Z"),
  paths: ["/_ff/records"], path_count: "1", countries: ["IS"], hosting: ["residential"], client_types: ["browser"],
  agents: ["unidentified"], networks: null, fp_list: ["aaaa1111:browser"], sigs: ["bbbb2222"], sig_count: "1",
  n_blocked: "0", n_contained: "1", n_recorded: "0", postures: ["enforce"], reason_kinds: ["decoy"],
} as unknown as Parameters<typeof signalFromRow>[0];

describe("incident detail from the grouped row", () => {
  it("maps exact times, counts, outcomes and source; nulls become empty lists", () => {
    const s = signalFromRow(ROW);
    expect(s.kind).toBe("honeytoken_trip");
    expect(s.attackClass).toBe("honeytoken_trip");
    expect(s.detail).toMatchObject({
      firstAt: "2026-10-26T10:05:37.367Z", lastAt: "2026-10-26T10:05:37.367Z", count: 1, windowStart: "2026-10-26T06:00:00.000Z",
      paths: ["/_ff/records"], pathCount: 1, countries: ["IS"], networks: [], fingerprints: ["aaaa1111:browser"], signatures: ["bbbb2222"],
      outcomes: { blocked: 0, contained: 1, recorded: 0 }, postures: ["enforce"], reasonKinds: ["decoy"],
    });
  });

  it("the scan SQL selects exact first/last times and per-request outcomes", async () => {
    await liveForcefieldAlertDeps().listHostileSignals(24);
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toContain("min(created_at) AS first_at");
    expect(sql).toContain("max(created_at) AS last_at");
    expect(sql).toMatch(/props->>'blocked' = 'true'\) AS n_blocked/);
    expect(sql).toMatch(/AS n_contained/);
    expect(sql).toMatch(/AS n_recorded/);
    expect(sql).toContain(EXCLUDE_SYNTHETIC_SQL);
  });
});

describe("lookupBlockDecision (reads what was recorded)", () => {
  const ENF = async () => ({ mode: "enforce" as const, autoBlock: true });
  it("blocked when a served automatic row exists and the policy enforces", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ fp: "aaaa1111:sqlmap", expires_at: "2026-11-09 10:05:37+00" }] });
    expect(await lookupBlockDecision(["aaaa1111:sqlmap"], "2026-10-26T06:00:00Z", ENF)).toEqual({ state: "blocked", fingerprints: ["aaaa1111:sqlmap"], expiresAt: "2026-11-09T10:05:37.000Z" });
  });

  it("a stored automatic row on a GENERIC fingerprint is not served, so it is never reported as blocked", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ fp: "1c168f78:curl", expires_at: "2026-11-08 00:00:00+00" }] })
      .mockResolvedValueOnce({ rows: [] });
    expect((await lookupBlockDecision(["1c168f78:curl"], "2026-10-26T06:00:00Z", ENF))?.state).toBe("none");
  });

  it("not blocked while the edge policy is off enforce + auto_block", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ fp: "aaaa1111:sqlmap", expires_at: null }] }).mockResolvedValueOnce({ rows: [] });
    expect((await lookupBlockDecision(["aaaa1111:sqlmap"], "2026-10-26T06:00:00Z", async () => ({ mode: "monitor", autoBlock: false })))?.state).toBe("none");
  });

  it("withheld when the durable withheld event names the fingerprint", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ fps: "zzzz:curl,aaaa1111:browser", why: "common_client_kind" }] });
    expect(await lookupBlockDecision(["aaaa1111:browser"], "2026-10-26T06:00:00Z", ENF)).toEqual({ state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" });
    expect(mockSafeQuery.mock.calls[1][1]).toEqual(["2026-10-26T06:00:00Z"]);
  });

  it("null on a read error and for no fingerprints", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("db"));
    expect(await lookupBlockDecision(["aaaa1111:browser"], "2026-10-26T06:00:00Z", ENF)).toBeNull();
    expect(await lookupBlockDecision([], "2026-10-26T06:00:00Z", ENF)).toBeNull();
  });
});

describe("one email per incident", () => {
  it("a trap trip whose automatic block was withheld produces ONE email carrying the decision", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 1, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    const m = memoryDeps([signalFromRow(ROW)]);
    m.deps.deliver = deliverForcefieldAlert;
    m.deps.enrich = async (a) => ({ ...a, incident: { ...a.incident!, blockDecision: { state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" } } });
    await scanForcefieldWebAlerts(m.deps);
    await scanForcefieldWebAlerts(m.deps); // a re-scan in the same window adds nothing
    expect(mockSendViaGraph).toHaveBeenCalledTimes(1);
    const mail = mockSendViaGraph.mock.calls[0][0];
    expect(mail.subject).toBe("[Forcefield] ogiam.com: hostile agent contained (decoy)");
    expect(mail.text).toContain("Automatic block not applied");
    expect(mail.text).toContain("When: 2026-10-26 10:05:37 UTC");
    expect(mail.html).toContain("https://wolfpack-instinct.vercel.app/admin/site-analytics?tab=forcefield&amp;view=operator&amp;find=bbbb2222");
    expect(mail.html).not.toMatch(/href="\//); // never a relative link
  });

  it("enrich runs only after a successful claim, and a throwing enrich still sends", async () => {
    const enrich = jest.fn(async () => { throw new Error("db"); });
    const m = memoryDeps([signalFromRow(ROW)]);
    m.deps.enrich = enrich;
    await scanForcefieldWebAlerts(m.deps);
    await scanForcefieldWebAlerts(m.deps);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(m.sent).toHaveLength(1);
  });

  it("the live enrich reads the decision only for a trap trip with a fingerprint", async () => {
    const enrich = liveForcefieldAlertDeps().enrich!;
    const payload = signalFromRow({ ...ROW, kind: "site.agent_payload_attack", attack: "sql_injection" } as typeof ROW);
    const { alertFromSignal } = await import("../alerts");
    await enrich(alertFromSignal(payload));
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("the footer alert id is the dedupe-store row id", () => {
    expect(alertRowId({ kind: "honeytoken_trip", dedupeKey: "k" })).toMatch(/^[0-9a-f]{24}$/);
  });
});
