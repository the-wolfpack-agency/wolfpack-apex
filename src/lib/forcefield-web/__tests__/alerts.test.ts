/**
 * Forcefield-web alerting: severity routing (decoy or unblocked -> immediate,
 * fully blocked -> digest only), one email per incident listing every class,
 * dedupe per incident and window, the once-per-day digest claim, no lost
 * incident across digests, the recorded delivery outcome (failure recorded and
 * retried, never swallowed), Graph + in-app delivery, synthetic exclusion and
 * the silence check.
 */
const mockFanout = jest.fn();
const mockSendViaGraph = jest.fn();
const mockTrackAwait = jest.fn();
jest.mock("@/lib/notifications/team-fanout", () => ({ fanoutToTeam: (...a: unknown[]) => mockFanout(...a) }));
jest.mock("@/lib/mail/send-via-graph", () => ({ sendViaGraph: (...a: unknown[]) => mockSendViaGraph(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: (...a: unknown[]) => mockTrackAwait(...a), trackEvent: jest.fn() }));
const mockSafeQuery = jest.fn<Promise<{ rows: unknown[] }>, unknown[]>(async () => ({ rows: [] }));
const mockQuery = jest.fn<Promise<{ rows: unknown[]; rowCount?: number }>, unknown[]>(async () => ({ rows: [], rowCount: 0 }));
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import {
  scanForcefieldWebAlerts,
  runDailyDigest,
  runAlertSilenceCheck,
  deliverForcefieldAlert,
  dispatchForcefieldAlert,
  alertFromIncident,
  incidentKey,
  digestKey,
  windowStartOf,
  isSilenceCheckHour,
  fingerprintPhrase,
  liveForcefieldAlertDeps,
  liveAlertStore,
  eventGroupFromRow,
  lookupBlockDecision,
  alertRowId,
  EXCLUDE_SYNTHETIC_SQL,
  ATTENTION_SQL,
  HOSTILE_EVENTS_SQL,
  MAX_ATTEMPTS,
  type ForcefieldAlert,
  type ForcefieldAlertDeps,
  type DeliveryOutcome,
  type DigestRowStatus,
} from "../alerts";
import { buildIncidents, digestResumeFrom, type HostileEventGroup } from "../incidents";

const OK: DeliveryOutcome = { status: "delivered", inAppRecipients: 1, emailAttempted: 1, emailDelivered: 1, detail: "" };
const FAIL: DeliveryOutcome = { status: "failed", inAppRecipients: 0, emailAttempted: 1, emailDelivered: 0, detail: "email:no_mail_from" };

/** One collapsed event group (synthetic identifiers). */
function ev(over: Partial<HostileEventGroup> = {}): HostileEventGroup {
  const firstAt = over.firstAt ?? "2026-10-26T14:02:44.388Z";
  return {
    kind: "payload_attack", site: "instinct", attackClass: "open_redirect", windowStart: windowStartOf(new Date(firstAt)),
    fp: "fp-a:browser", sig: "sig-1", path: "/bitrix/redirect.php", country: "US", hosting: "residential", clientType: "browser",
    agent: "unidentified", network: "", outcome: "blocked", posture: "enforce", reasonKind: "payload",
    count: 1, firstAt, lastAt: over.lastAt ?? firstAt, ...over,
  };
}

/**
 * An in-memory store with the SAME semantics as the SQL: a new key inserts; a
 * delivered or empty key never re-claims; a failed key re-claims until
 * MAX_ATTEMPTS. listHostileEvents filters the event list by created time.
 */
function memoryDeps(events: HostileEventGroup[], opts: { outcome?: DeliveryOutcome } = {}) {
  const rows = new Map<string, { status: DigestRowStatus; attempts: number; kind: string; windowStart?: string }>();
  const sent: ForcefieldAlert[] = [];
  const tracked: { event: string; payload: Record<string, unknown> }[] = [];
  const state = { events };
  const deps: ForcefieldAlertDeps = {
    listHostileEvents: async (since, until) => state.events.filter((g) => new Date(g.firstAt) >= new Date(since) && new Date(g.firstAt) < new Date(until)),
    claimAlert: async (a) => {
      const k = `${a.kind}:${a.dedupeKey}`;
      const r = rows.get(k);
      if (!r) { rows.set(k, { status: null, attempts: 1, kind: a.kind, windowStart: a.windowStart }); return true; }
      if (r.status === "failed" && r.attempts < MAX_ATTEMPTS) { r.attempts++; return true; }
      return false;
    },
    deliver: async (a) => { sent.push(a); return opts.outcome ?? OK; },
    recordOutcome: async (a, o) => { rows.get(`${a.kind}:${a.dedupeKey}`)!.status = o.status; },
    recordDigestEmpty: async (a) => { rows.get(`${a.kind}:${a.dedupeKey}`)!.status = "empty"; },
    digestResumeFrom: async (before) => {
      const digests = [...rows.values()].filter((r) => r.kind === "alert_digest" && r.windowStart && r.windowStart < before);
      const handled = digests.filter((r) => r.status === "delivered" || r.status === "empty").map((r) => r.windowStart!).sort().pop();
      const unhandled = digests.filter((r) => r.status !== "delivered" && r.status !== "empty" && (!handled || r.windowStart! > handled)).map((r) => r.windowStart!).sort()[0];
      return digestResumeFrom(handled ? new Date(handled) : null, unhandled ? new Date(unhandled) : null);
    },
    digestStatus: async (key) => rows.get(`alert_digest:${key}`)?.status ?? null,
    track: async (event, payload) => { tracked.push({ event, payload }); },
    countAttentionEvents: async () => state.events.filter((g) => g.kind === "honeytoken_trip" || g.outcome === "recorded").reduce((n, g) => n + g.count, 0),
    countHostileEventsBetween: async (since, until) => state.events.filter((g) => g.firstAt >= since && g.firstAt < until).reduce((n, g) => n + g.count, 0),
    countDeliveredAlerts: async () => [...rows.values()].filter((r) => r.status === "delivered" && r.kind !== "alert_silence" && r.kind !== "alert_digest").length,
  };
  return { deps, rows, sent, tracked, state };
}

/** The 2026-10-26 14:02 scanner burst, shape-for-shape (synthetic ids): 28
 *  requests, 8 attack classes, 5 fingerprints, 28 signatures, all blocked. */
function scannerBurst(): HostileEventGroup[] {
  const classes: [string, number, string][] = [
    ["open_redirect", 14, "fp-a:browser"], ["path_traversal", 6, "fp-c:unknown"], ["sql_injection", 4, "fp-c:unknown"],
    ["xss", 1, "fp-c:unknown"], ["ssrf", 1, "fp-a:browser"], ["php_cgi_injection", 1, "fp-d:unknown"], ["command_injection", 1, "fp-c:unknown"],
  ];
  const out: HostileEventGroup[] = [];
  let n = 0;
  for (const [attackClass, count, fp] of classes) {
    for (let i = 0; i < count; i++) {
      const t = new Date(Date.parse("2026-10-26T14:02:44.388Z") + n * 50).toISOString();
      out.push(ev({ attackClass, fp, sig: `sig-${n}`, path: `/p/${attackClass}/${i % 3}`, firstAt: t, lastAt: t }));
      n++;
    }
  }
  // The straggler 14 seconds later (the real burst's last request).
  out.push(ev({ attackClass: "sql_injection", fp: "fp-c:unknown", sig: "sig-last", path: "/module/x", firstAt: "2026-10-26T14:03:00.295Z" }));
  return out;
}

const AT_1430 = new Date("2026-10-26T14:30:00Z");

beforeEach(() => jest.clearAllMocks());

describe("severity routing", () => {
  it("a decoy trip is immediate, even when it was contained", async () => {
    const m = memoryDeps([ev({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained", reasonKind: "decoy", site: "ogiam.com", path: "/_ff/records" })]);
    const r = await scanForcefieldWebAlerts(m.deps, AT_1430);
    expect(r).toMatchObject({ detected: 1, immediate: 1, digestOnly: 0, dispatched: 1, delivered: 1 });
    expect(m.sent[0].kind).toBe("hostile_incident");
    expect(m.sent[0].attention).toEqual(["decoy"]);
    expect(m.sent[0].title).toBe("[Forcefield] ogiam.com: hostile agent contained (decoy)");
  });

  it("a request recorded but not blocked (watch / report-only) is immediate", async () => {
    const m = memoryDeps([ev({ attackClass: "nextjs_middleware_bypass", outcome: "recorded", posture: "monitor", count: 40 })]);
    const r = await scanForcefieldWebAlerts(m.deps, AT_1430);
    expect(r.immediate).toBe(1);
    expect(m.sent[0].attention).toEqual(["unblocked"]);
    expect(m.sent[0].title).toBe("[Forcefield] wolfpack-instinct.vercel.app: Next.js middleware bypass recorded, not blocked (40 attempts)");
  });

  it("a fully blocked payload attack sends NO immediate email (digest only)", async () => {
    const m = memoryDeps([ev()]);
    const r = await scanForcefieldWebAlerts(m.deps, AT_1430);
    expect(r).toMatchObject({ detected: 1, immediate: 0, digestOnly: 1, dispatched: 0 });
    expect(m.sent).toHaveLength(0);
  });

  it("the real 14:02 burst (all blocked) is ONE incident and sends nothing immediately", async () => {
    const burst = scannerBurst();
    expect(buildIncidents(burst)).toHaveLength(1);
    const m = memoryDeps(burst);
    const r = await scanForcefieldWebAlerts(m.deps, AT_1430);
    expect(r).toMatchObject({ detected: 1, immediate: 0, digestOnly: 1, dispatched: 0 });
    expect(m.sent).toHaveLength(0);
  });
});

describe("grouping: one email per incident, never per attack class", () => {
  it("a mixed burst with ONE unblocked request sends ONE email listing every class and count", async () => {
    const burst = scannerBurst();
    burst[3] = { ...burst[3], outcome: "recorded", posture: "monitor" };
    const m = memoryDeps(burst);
    const r = await scanForcefieldWebAlerts(m.deps, AT_1430);
    expect(r).toMatchObject({ detected: 1, immediate: 1, dispatched: 1 });
    expect(m.sent).toHaveLength(1);
    const a = m.sent[0];
    expect(a.classes!.map((c) => [c.attackClass, c.count])).toEqual([
      ["open_redirect", 14], ["path_traversal", 6], ["sql_injection", 5], ["command_injection", 1], ["php_cgi_injection", 1], ["ssrf", 1], ["xss", 1],
    ]);
    expect(a.incident!.count).toBe(29);
    expect(a.incident!.outcomes).toEqual({ blocked: 28, contained: 0, recorded: 1 });
    expect(a.incident!.firstAt).toBe("2026-10-26T14:02:44.388Z");
    expect(a.incident!.lastAt).toBe("2026-10-26T14:03:00.295Z");
    expect(a.title).toBe("[Forcefield] wolfpack-instinct.vercel.app: 7 attack types partly stopped (29 attempts)");
    expect(a.metadata).toMatchObject({ count: 29, classes: 7, not_blocked: 1, attention: "unblocked" });
  });

  it("a re-scan inside the window does not re-send; the next window does", async () => {
    const one = ev({ outcome: "recorded" });
    const m = memoryDeps([one]);
    await scanForcefieldWebAlerts(m.deps, AT_1430);
    await scanForcefieldWebAlerts(m.deps, new Date("2026-10-26T14:40:00Z"));
    expect(m.sent).toHaveLength(1);
    // More requests from the same source later in the window: same incident.
    m.state.events = [one, ev({ outcome: "recorded", sig: "sig-9", firstAt: "2026-10-26T16:00:00.000Z" })];
    await scanForcefieldWebAlerts(m.deps, new Date("2026-10-26T16:10:00Z"));
    expect(m.sent).toHaveLength(1);
    m.state.events.push(ev({ outcome: "recorded", firstAt: "2026-10-26T18:30:00.000Z" }));
    await scanForcefieldWebAlerts(m.deps, new Date("2026-10-26T18:40:00Z"));
    expect(m.sent).toHaveLength(2);
  });

  it("an unrelated source in the same window, hours apart, is its own incident", async () => {
    const m = memoryDeps([
      ev({ outcome: "recorded", fp: "fp-a", sig: "s1", firstAt: "2026-10-26T12:10:00.000Z" }),
      ev({ outcome: "recorded", fp: "fp-b", sig: "s2", firstAt: "2026-10-26T15:10:00.000Z" }),
    ]);
    expect((await scanForcefieldWebAlerts(m.deps, new Date("2026-10-26T15:20:00Z"))).dispatched).toBe(2);
  });

  it("incidentKey separates site, identity and window", () => {
    const k = incidentKey("hostile_incident", "ogiam.com", "a", "2026-10-24T12:00:00.000Z");
    expect(k).toBe(incidentKey("hostile_incident", "ogiam.com", "a", "2026-10-24T12:00:00.000Z"));
    expect(k).not.toBe(incidentKey("hostile_incident", "ogiam.com", "a", "2026-10-24T18:00:00.000Z"));
    expect(k).not.toBe(incidentKey("hostile_incident", "instinct", "a", "2026-10-24T12:00:00.000Z"));
    expect(k).not.toBe(incidentKey("hostile_incident", "ogiam.com", "b", "2026-10-24T12:00:00.000Z"));
  });

  it("windowStartOf aligns to fixed 6-hour windows", () => {
    expect(windowStartOf(new Date("2026-10-24T13:59:00Z"))).toBe("2026-10-24T12:00:00.000Z");
    expect(windowStartOf(new Date("2026-10-24T18:00:00Z"))).toBe("2026-10-24T18:00:00.000Z");
  });
});

describe("daily digest", () => {
  // 2026-10-27 08:05 EDT = 12:05 UTC. Period: windows from 2026-10-26 12:00 to 2026-10-27 12:00 UTC.
  const DUE = new Date("2026-10-27T12:05:00Z");

  it("is not due before 08:00 US Eastern", async () => {
    const m = memoryDeps(scannerBurst());
    const r = await runDailyDigest(m.deps, new Date("2026-10-27T11:55:00Z"));
    expect(r).toMatchObject({ due: false, outcome: "skipped" });
    expect(m.sent).toHaveLength(0);
  });

  it("sends ONE digest per Eastern date, however many scans run after 08:00 (the claim)", async () => {
    const m = memoryDeps(scannerBurst());
    const first = await runDailyDigest(m.deps, DUE);
    expect(first).toMatchObject({ due: true, claimed: true, outcome: "sent", incidents: 1, attempts: 29, etDate: "2026-10-27", periodStart: "2026-10-26T12:00:00.000Z", periodEnd: "2026-10-27T12:00:00.000Z" });
    for (const t of ["2026-10-27T12:15:00Z", "2026-10-27T18:00:00Z", "2026-10-28T03:59:00Z"]) {
      expect((await runDailyDigest(m.deps, new Date(t))).claimed).toBe(false);
    }
    expect(m.sent).toHaveLength(1);
    const d = m.sent[0].digest!;
    expect(m.sent[0].kind).toBe("alert_digest");
    expect(d.sites.map((s) => [s.site, s.incidents, s.attempts, s.sources])).toEqual([["instinct", 1, 29, 3]]);
    expect(d.sites[0].rows[0]).toMatchObject({ attackClass: "open_redirect", count: 14, outcomes: { blocked: 14, contained: 0, recorded: 0 } });
    expect(m.tracked.find((t) => t.event === "forcefield.alert_digest_built")!.payload).toMatchObject({ outcome: "sent", incidents: 1, attempts: 29 });
    expect(m.tracked.find((t) => t.event === "forcefield.web_alert_dispatched")!.payload).toMatchObject({ kind: "alert_digest", outcome: "delivered" });
  });

  it("is skipped (no email) when nothing was blocked in the period, and recorded as handled", async () => {
    const m = memoryDeps([]);
    expect((await runDailyDigest(m.deps, DUE)).outcome).toBe("empty");
    expect(m.sent).toHaveLength(0);
    expect(m.rows.get(`alert_digest:${digestKey("2026-10-27")}`)!.status).toBe("empty");
    expect((await runDailyDigest(m.deps, new Date("2026-10-27T13:00:00Z"))).claimed).toBe(false);
  });

  it("an immediate incident is not repeated in the digest (counted as sent immediately)", async () => {
    const m = memoryDeps([ev({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained", fp: "x", sig: "y", firstAt: "2026-10-26T20:00:00.000Z" }), ...scannerBurst()]);
    await runDailyDigest(m.deps, DUE);
    expect(m.sent[0].digest!.totals.incidents).toBe(1);
    expect(m.sent[0].digest!.immediateIncidents).toBe(1);
  });

  it("a failed send is retried on later scans, then a later digest covers its period (nothing lost)", async () => {
    const m = memoryDeps(scannerBurst(), { outcome: FAIL });
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await runDailyDigest(m.deps, new Date(DUE.getTime() + i * 600_000));
    expect(m.sent).toHaveLength(MAX_ATTEMPTS);
    // Next day the mailer works again: the failed period rolls into this digest.
    m.deps.deliver = async (a) => { m.sent.push(a); return OK; };
    const r = await runDailyDigest(m.deps, new Date("2026-10-28T12:05:00Z"));
    expect(r).toMatchObject({ outcome: "sent", periodStart: "2026-10-26T12:00:00.000Z", periodEnd: "2026-10-28T12:00:00.000Z", incidents: 1 });
  });

  it("a read failure is a failed digest (retried), never an empty one", async () => {
    const m = memoryDeps(scannerBurst());
    m.deps.listHostileEvents = async () => { throw new Error("db down"); };
    expect((await runDailyDigest(m.deps, DUE)).outcome).toBe("failed");
    expect(m.rows.get(`alert_digest:${digestKey("2026-10-27")}`)!.status).toBe("failed");
    m.deps.listHostileEvents = async (since, until) => scannerBurst().filter((g) => g.firstAt >= since && g.firstAt < until);
    expect((await runDailyDigest(m.deps, new Date("2026-10-27T12:15:00Z"))).outcome).toBe("sent");
  });

  it("NO LOST INCIDENT: every blocked incident appears in exactly one digest across days and DST", async () => {
    // A blocked incident every 2 hours for 9 days, across the 2026-11-01 DST change,
    // with incidents straddling every window and cutoff boundary.
    const events: HostileEventGroup[] = [];
    const start = Date.parse("2026-10-27T00:30:00Z");
    for (let h = 0; h < 9 * 24; h += 2) {
      const t = new Date(start + h * 3600_000).toISOString();
      events.push(ev({ fp: `fp-${h}`, sig: `sig-${h}`, firstAt: t, lastAt: t }));
    }
    const expected = buildIncidents(events).filter((i) => i.route === "digest").map((i) => `${i.site}|${i.windowStart}|${i.anchor}`);
    const m = memoryDeps(events);
    const seen: string[] = [];
    // A scan every 10 minutes from 2026-10-27 to 2026-11-06.
    for (let t = Date.parse("2026-10-27T00:00:00Z"); t < Date.parse("2026-11-06T00:00:00Z"); t += 600_000) {
      const r = await runDailyDigest(m.deps, new Date(t));
      if (r.outcome === "sent") seen.push(...m.sent[m.sent.length - 1].digest!.incidentKeys);
    }
    const covered = new Set(seen);
    expect(seen.length).toBe(covered.size); // never twice
    const last = Date.parse("2026-11-05T12:00:00Z"); // the 2026-11-05 cutoff (EST: 13:00 floored to 12:00)
    const due = expected.filter((k) => Date.parse(k.split("|")[1]) < last);
    expect(due.length).toBeGreaterThan(90);
    expect(due.filter((k) => !covered.has(k))).toEqual([]); // never missed
    expect(m.sent).toHaveLength(10); // one per day, 2026-10-27 .. 2026-11-05
  });
});

describe("delivery failures are recorded, never swallowed", () => {
  it("records outcome=failed with the reason and counts it as failed", async () => {
    const m = memoryDeps([ev({ outcome: "recorded" })], { outcome: FAIL });
    const r = await scanForcefieldWebAlerts(m.deps, AT_1430);
    expect(r).toMatchObject({ detected: 1, dispatched: 1, delivered: 0, failed: 1 });
    const t = m.tracked.find((x) => x.event === "forcefield.web_alert_dispatched")!;
    expect(t.payload.outcome).toBe("failed");
    expect(t.payload.detail).toBe("email:no_mail_from");
  });

  it("retries a failed alert on the next scan, up to MAX_ATTEMPTS", async () => {
    const m = memoryDeps([ev({ outcome: "recorded" })], { outcome: FAIL });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await scanForcefieldWebAlerts(m.deps, AT_1430);
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
  const CHECK = new Date("2026-10-27T15:05:00Z");

  it("fires when an incident needing attention got no immediate alert", async () => {
    const m = memoryDeps([ev({ outcome: "recorded", firstAt: "2026-10-27T13:00:00.000Z" })]);
    m.rows.set(`alert_digest:${digestKey("2026-10-27")}`, { status: "empty", attempts: 1, kind: "alert_digest" });
    const r = await runAlertSilenceCheck(m.deps, CHECK);
    expect(r.silent).toBe(true);
    expect(r.reasons).toEqual(["immediate"]);
    expect(m.sent[0].kind).toBe("alert_silence");
    expect(m.tracked.map((t) => t.event)).toContain("forcefield.alert_silence_detected");
  });

  it("does NOT fire for blocked-only traffic once the day's digest went out", async () => {
    const m = memoryDeps(scannerBurst());
    await scanForcefieldWebAlerts(m.deps, AT_1430);
    await runDailyDigest(m.deps, new Date("2026-10-27T12:05:00Z"));
    const r = await runAlertSilenceCheck(m.deps, CHECK);
    expect(r).toMatchObject({ silent: false, digestStatus: "delivered" });
    expect(m.sent.filter((a) => a.kind === "alert_silence")).toHaveLength(0);
  });

  it("fires when blocked traffic fell in today's period but the digest never went out", async () => {
    const m = memoryDeps(scannerBurst());
    const r = await runAlertSilenceCheck(m.deps, CHECK);
    expect(r.reasons).toEqual(["digest"]);
    expect(r.digestEvents).toBe(29);
  });

  it("fires when every immediate alert FAILED to deliver (a broken mailer is silence too)", async () => {
    const m = memoryDeps([ev({ outcome: "recorded", firstAt: "2026-10-27T13:00:00.000Z" })], { outcome: FAIL });
    await scanForcefieldWebAlerts(m.deps, new Date("2026-10-27T13:10:00Z"));
    expect((await runAlertSilenceCheck(m.deps, CHECK)).reasons).toContain("immediate");
  });

  it("does not fire with no hostile traffic, and at most once per UTC day", async () => {
    const quiet = memoryDeps([]);
    expect((await runAlertSilenceCheck(quiet.deps, CHECK)).silent).toBe(false);
    const m = memoryDeps(scannerBurst());
    await runAlertSilenceCheck(m.deps, CHECK);
    await runAlertSilenceCheck(m.deps, new Date("2026-10-27T15:50:00Z"));
    expect(m.sent).toHaveLength(1);
  });

  it("runs during the 15:00 UTC hour only (after the 8 AM ET digest in both EDT and EST)", () => {
    expect(isSilenceCheckHour(new Date("2026-10-24T15:40:00Z"))).toBe(true);
    expect(isSilenceCheckHour(new Date("2026-10-24T12:00:00Z"))).toBe(false);
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
    expect(mail.html).not.toContain("<b>");
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
    expect((await deliverForcefieldAlert(ALERT)).status).toBe("failed");
  });

  it("a grouped incident email is escaped and names the hostname, not the label", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 1, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    const [inc] = buildIncidents([ev({ outcome: "recorded", path: "/<script>x</script>" })]);
    await deliverForcefieldAlert(alertFromIncident(inc));
    const mail = mockSendViaGraph.mock.calls[0][0];
    expect(mail.html).not.toContain("<script>x");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.subject).toContain("wolfpack-instinct.vercel.app");
    expect(mail.text).toContain("Site: wolfpack-instinct.vercel.app");
    expect(mail.text).not.toMatch(/Site: instinct\b/);
  });
});

describe("fingerprint wording", () => {
  it("fingerprintPhrase treats 0, negative and NaN as not recorded", () => {
    expect(fingerprintPhrase(0)).toBe("Fingerprint not recorded");
    expect(fingerprintPhrase(-1)).toBe("Fingerprint not recorded");
    expect(fingerprintPhrase(Number.NaN)).toBe("Fingerprint not recorded");
    expect(fingerprintPhrase(2)).toBe("2 distinct fingerprints");
  });
});

describe("our own synthetic probes are never alerted on or counted", () => {
  it("the event query (scan AND digest) excludes events stamped props.synthetic", async () => {
    await liveForcefieldAlertDeps().listHostileEvents("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toBe(HOSTILE_EVENTS_SQL);
    expect(sql).toContain(EXCLUDE_SYNTHETIC_SQL);
    expect(EXCLUDE_SYNTHETIC_SQL).toMatch(/props->>'synthetic'/);
    expect(mockQuery.mock.calls[0][1]).toEqual(["2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", 6, ["site.agent_trap_tripped", "site.agent_payload_attack"]]);
  });

  it("the silence check's counts exclude them too", async () => {
    await liveForcefieldAlertDeps().countAttentionEvents(24);
    await liveForcefieldAlertDeps().countHostileEventsBetween("a", "b");
    for (const i of [0, 1]) expect(String(mockSafeQuery.mock.calls[i][0])).toContain(EXCLUDE_SYNTHETIC_SQL);
    expect(String(mockSafeQuery.mock.calls[0][0])).toContain(ATTENTION_SQL);
  });

  it("the exemption keys on the token-attested mark only, never the user agent", async () => {
    await liveForcefieldAlertDeps().countAttentionEvents(24);
    for (const sql of [HOSTILE_EVENTS_SQL, String(mockSafeQuery.mock.calls[0][0])]) {
      expect(sql).not.toMatch(/user.?agent|wolfpack-verify|props->>'ua'/i);
      expect(sql).not.toMatch(/props->>'authenticated'/);
    }
  });

  it("a read error in the event query throws (never a silent empty result)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(liveForcefieldAlertDeps().listHostileEvents("a", "b")).rejects.toThrow("db down");
  });
});

describe("the collapsed row", () => {
  const ROW = {
    kind: "site.agent_trap_tripped", site: "ogiam.com", attack: "site.agent_trap_tripped", window_start: new Date("2026-10-26T06:00:00.000Z"),
    fp: "aaaa1111:browser", sig: "bbbb2222", path: "/_ff/records", country: "IS", hosting: "residential", client_type: "browser", agent: "unidentified",
    network: "", outcome: "contained", posture: "enforce", reason_kind: "decoy", n: "3",
    first_at: new Date("2026-10-26T10:05:37.367Z"), last_at: new Date("2026-10-26T10:06:00.000Z"),
  };
  it("maps exact times, counts and outcome", () => {
    expect(eventGroupFromRow(ROW)).toMatchObject({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", count: 3, outcome: "contained", windowStart: "2026-10-26T06:00:00.000Z", firstAt: "2026-10-26T10:05:37.367Z" });
    expect(eventGroupFromRow({ ...ROW, outcome: "weird" }).outcome).toBe("recorded");
  });
  it("the SQL classifies blocked, contained (tarpit) and recorded per request", () => {
    expect(HOSTILE_EVENTS_SQL).toMatch(/WHEN props->>'blocked' = 'true' THEN 'blocked'/);
    expect(HOSTILE_EVENTS_SQL).toMatch(/props->>'tarpit' = 'true' OR props->>'action' = 'tarpit' THEN 'contained'/);
    expect(HOSTILE_EVENTS_SQL).toMatch(/ELSE 'recorded'/);
    // Attempts sum repeat_count: a collapsed decoy row stands for many requests.
    expect(HOSTILE_EVENTS_SQL).toContain("sum(COALESCE((props->>'repeat_count')::int, 1)) AS n");
    expect(HOSTILE_EVENTS_SQL).toContain("last_seen");
  });
});

describe("the live digest store", () => {
  it("counts delivered immediate alerts only (digest and silence rows excluded)", async () => {
    await liveAlertStore().countDeliveredAlerts(24);
    expect(String(mockSafeQuery.mock.calls[0][0])).toMatch(/alert_kind NOT IN \('alert_silence', 'alert_digest'\)/);
  });
  it("the next period resumes at the latest HANDLED digest (delivered or empty)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ handled_end: "2026-10-26 12:00:00+00", first_unhandled_end: null }] });
    expect((await liveAlertStore().digestResumeFrom("2026-10-27T12:00:00.000Z"))?.toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/delivery_status IN \('delivered', 'empty'\)/);
  });
  it("with no handled digest, resumes at the start of the earliest unhandled one", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ handled_end: null, first_unhandled_end: "2026-10-27 12:00:00+00" }] });
    expect((await liveAlertStore().digestResumeFrom("2026-10-28T12:00:00.000Z"))?.toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });
});

describe("lookupBlockDecision (reads what was recorded)", () => {
  const ENF = async () => ({ mode: "enforce" as const, autoBlock: true });
  it("blocked when a served automatic row exists and the policy enforces", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ fp: "aaaa1111:sqlmap", expires_at: "2026-11-09 10:05:37+00" }] });
    expect(await lookupBlockDecision(["aaaa1111:sqlmap"], "2026-10-26T06:00:00Z", ENF)).toEqual({ state: "blocked", fingerprints: ["aaaa1111:sqlmap"], expiresAt: "2026-11-09T10:05:37.000Z" });
  });

  it("a stored automatic row on a GENERIC fingerprint is not served, so it is never reported as blocked", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ fp: "1c168f78:curl", expires_at: "2026-11-08 00:00:00+00" }] }).mockResolvedValueOnce({ rows: [] });
    expect((await lookupBlockDecision(["1c168f78:curl"], "2026-10-26T06:00:00Z", ENF))?.state).toBe("none");
  });

  it("withheld when the durable withheld event names the fingerprint", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ fps: "zzzz:curl,aaaa1111:browser", why: "common_client_kind" }] });
    expect(await lookupBlockDecision(["aaaa1111:browser"], "2026-10-26T06:00:00Z", ENF)).toEqual({ state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" });
  });

  it("null on a read error and for no fingerprints", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("db"));
    expect(await lookupBlockDecision(["aaaa1111:browser"], "2026-10-26T06:00:00Z", ENF)).toBeNull();
    expect(await lookupBlockDecision([], "2026-10-26T06:00:00Z", ENF)).toBeNull();
  });
});

describe("one email per incident, with the block decision", () => {
  const trap = () => ev({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained", reasonKind: "decoy", site: "ogiam.com", fp: "aaaa1111:browser", sig: "bbbb2222", path: "/_ff/records", country: "IS", firstAt: "2026-10-26T10:05:37.367Z" });

  it("a trap trip whose automatic block was withheld produces ONE email carrying the decision", async () => {
    mockFanout.mockResolvedValue({ recipientCount: 1, skipped: 0 });
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    const m = memoryDeps([trap()]);
    m.deps.deliver = deliverForcefieldAlert;
    m.deps.enrich = async (a) => ({ ...a, incident: { ...a.incident!, blockDecision: { state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" } } });
    const at = new Date("2026-10-26T10:10:00Z");
    await scanForcefieldWebAlerts(m.deps, at);
    await scanForcefieldWebAlerts(m.deps, at);
    expect(mockSendViaGraph).toHaveBeenCalledTimes(1);
    const mail = mockSendViaGraph.mock.calls[0][0];
    expect(mail.subject).toBe("[Forcefield] ogiam.com: hostile agent contained (decoy)");
    expect(mail.text).toContain("Why we did not block this visitor everywhere");
    expect(mail.text).toContain("When: 2026-10-26 10:05:37 UTC");
    expect(mail.html).toContain("https://wolfpack-instinct.vercel.app/admin/site-analytics?tab=forcefield&amp;view=operator&amp;find=bbbb2222&amp;days=7&amp;site=ogiam.com");
    expect(mail.html).not.toMatch(/href="\//);
  });

  it("enrich runs only after a successful claim, and a throwing enrich still sends", async () => {
    const enrich = jest.fn(async () => { throw new Error("db"); });
    const m = memoryDeps([trap()]);
    m.deps.enrich = enrich;
    const at = new Date("2026-10-26T10:10:00Z");
    await scanForcefieldWebAlerts(m.deps, at);
    await scanForcefieldWebAlerts(m.deps, at);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(m.sent).toHaveLength(1);
  });

  it("the live enrich reads the decision only for an incident with a trap trip", async () => {
    const enrich = liveForcefieldAlertDeps().enrich!;
    const [inc] = buildIncidents([ev({ outcome: "recorded" })]);
    await enrich(alertFromIncident(inc));
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("the footer alert id is the dedupe-store row id", () => {
    expect(alertRowId({ kind: "hostile_incident", dedupeKey: "k" })).toMatch(/^[0-9a-f]{24}$/);
  });
});
