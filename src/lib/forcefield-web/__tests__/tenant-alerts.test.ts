/** @jest-environment node */
/**
 * Tenant notifications: scoped to the tenant's own events and site, links to the
 * client dashboard only (never /admin), one unsubscribe link in every email,
 * first evidence sent once (released for retry on a provider failure, kept on an
 * allowlist refusal), incidents routed like the operator path (only "immediate"
 * incidents email now; a fully blocked one waits for the summary), alerts only
 * since the address was confirmed and capped, tenant dedupe keys distinct from
 * the operator's, digest only in its hour and only with traffic.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));

import {
  runTenantNotifications, tenantAlertFromIncident, renderTenantAlert, tenantIncidentKey, TENANT_EVENTS_SQL,
  MAX_ALERTS_PER_TENANT_RUN, DIGEST_HOUR_UTC, FIRST_HOUR_SETTLE_MS, type TenantNotifyDeps, type ConfirmedTenant,
} from "@/lib/forcefield-web/tenant-alerts";
import { alertFromIncident, HOSTILE_EVENTS_SQL } from "@/lib/forcefield-web/alerts";
import { buildIncidents, type HostileEventGroup } from "@/lib/forcefield-web/incidents";
import type { TenantMail } from "@/lib/forcefield-web/tenant-mail";

const T: ConfirmedTenant = { id: "t1", name: "Acme Inc", siteLabel: "acme.com", email: "qa@thewolfpack.agency", confirmedAt: "2026-10-26T08:00:00.000Z", firstEvidenceAt: null };
/** One unblocked SQL injection burst on the tenant's site: routed "immediate". */
const GROUP: HostileEventGroup = {
  kind: "payload_attack", site: "acme.com", attackClass: "sql_injection", windowStart: "2026-10-26T06:00:00.000Z",
  fp: "fp1", sig: "sig1", path: "/q", country: "US", hosting: "datacenter", clientType: "scripted_library", agent: "", network: "AS1",
  outcome: "recorded", posture: "monitor", reasonKind: "payload", count: 3, firstAt: "2026-10-26T09:30:00.000Z", lastAt: "2026-10-26T09:30:05.000Z",
};
/** The same burst fully blocked at the edge: routed to the summary. */
const BLOCKED: HostileEventGroup = { ...GROUP, outcome: "blocked", posture: "enforce" };
const INC = buildIncidents([GROUP])[0];
const ACTIVITY = {
  sinceIso: "2026-10-26T09:00:00.000Z",
  counts: { agentsSeen: 4, welcomed: 1, slowed: 1, blocked: 1, caught: 1 },
  agents: [
    { name: "Googlebot", kind: "known_crawler", requests: 12, did: "Read your public pages", handled: "welcomed" as const, lastSeen: null },
    { name: "sqlmap", kind: "scanner", requests: 7, did: "Sent an attack payload (sql injection)", handled: "blocked" as const, lastSeen: null },
    { name: "python-requests", kind: "scripted_library", requests: 5, did: "Probed a sensitive path (env file)", handled: "slowed" as const, lastSeen: null },
    { name: "curl", kind: "scripted_library", requests: 2, did: "Visited as automation", handled: "caught" as const, lastSeen: null },
  ],
};
const STATS = { rangeDays: 1, agentsDetected: 9, welcomed: 2, trapped: 1, probed: 2, payloads: 3, hostile: 6, sitesProtected: 1, attacks: [{ attack: "sql_injection", count: 3 }] };

function deps(over: Partial<TenantNotifyDeps> = {}) {
  const mails: TenantMail[] = [];
  const d: TenantNotifyDeps = {
    listConfirmedTenants: async () => [T],
    firstEventAt: async () => "2026-10-26T09:00:00.000Z",
    activity: jest.fn(async () => ACTIVITY),
    claimFirstEvidence: jest.fn(async () => true),
    releaseFirstEvidence: jest.fn(async () => {}),
    stats: jest.fn(async () => STATS),
    listTenantEvents: jest.fn(async () => [GROUP]),
    claimAlert: jest.fn(async () => true),
    recordOutcome: jest.fn(async () => {}),
    claimDigest: jest.fn(async () => true),
    send: jest.fn(async (m: TenantMail) => { mails.push(m); return { delivered: true, reason: "ok" }; }),
    track: jest.fn(async () => {}),
    baseUrl: "https://instinct.example",
    unsubscribeToken: (id, email) => `unsub-${id}-${email}`,
    ...over,
  };
  return { d, mails };
}
const NOT_DIGEST = new Date("2026-10-26T10:05:00.000Z");
const DIGEST = new Date(`2026-10-26T${String(DIGEST_HOUR_UTC).padStart(2, "0")}:05:00.000Z`);

it("the tenant event query is the operator query plus the tenant scope, synthetic excluded", () => {
  expect(TENANT_EVENTS_SQL).toMatch(/WHERE forcefield_tenant_id = \$5\s+AND event_type = ANY\(\$4::text\[\]\)/);
  expect(TENANT_EVENTS_SQL.replace(/forcefield_tenant_id = \$5\s+AND /, "")).toBe(HOSTILE_EVENTS_SQL);
  expect(TENANT_EVENTS_SQL).toContain("props->>'synthetic'");
});

it("tenant dedupe keys differ from the operator key and between tenants", () => {
  const op = alertFromIncident(INC).dedupeKey;
  const a = tenantAlertFromIncident({ id: "t1", siteLabel: "acme.com" }, INC);
  const b = tenantAlertFromIncident({ id: "t2", siteLabel: "acme.com" }, INC);
  expect(a.kind).toBe("hostile_incident");
  expect(a.dedupeKey).not.toBe(op);
  expect(a.dedupeKey).not.toBe(b.dedupeKey);
  expect(a.dedupeKey).toBe(tenantIncidentKey("t1", alertFromIncident({ ...INC, site: "acme.com" }).dedupeKey));
  expect(a.metadata).toMatchObject({ audience: "tenant", tenant_id: "t1" });
});

it("a tenant alert names the tenant site even when the event's site prop differs", () => {
  const other = buildIncidents([{ ...GROUP, site: "other.example" }])[0];
  const a = tenantAlertFromIncident({ id: "t1", siteLabel: "acme.com" }, other);
  expect(a.site).toBe("acme.com");
  const email = renderTenantAlert(a, T, "https://instinct.example", "u");
  expect(email.text).not.toContain("other.example");
});

it("tenant alert emails link only to the client dashboard and carry one unsubscribe link", () => {
  const email = renderTenantAlert(tenantAlertFromIncident(T, INC), T, "https://instinct.example", "unsub-tok");
  const hrefs = email.links.map((l) => l.href);
  expect(hrefs.every((h) => !h.includes("/admin"))).toBe(true);
  expect(email.html).not.toContain("/admin");
  expect(email.text).not.toContain("/admin");
  expect(hrefs).toContain("https://instinct.example/forcefield/dashboard");
  expect(hrefs.filter((h) => h.includes("/forcefield/unsubscribe?token=unsub-tok"))).toHaveLength(1);
  expect(email.text).toContain("Unsubscribe: https://instinct.example/forcefield/unsubscribe?token=unsub-tok");
});

it("first hour + one incident alert, outside the digest hour", async () => {
  const { d, mails } = deps();
  const r = await runTenantNotifications(d, NOT_DIGEST);
  expect(r).toMatchObject({ tenants: 1, firstEvidence: 1, alertsDispatched: 1, alertsDelivered: 1, digests: 0, blocked: 0 });
  expect(mails.map((m) => m.purpose)).toEqual(["first_evidence", "alert"]);
  expect(mails.every((m) => m.to === T.email && m.tenantId === "t1")).toBe(true);
  expect(mails[0].subject).toBe("Your first hour with Forcefield on acme.com");
  // Counts of agents seen, welcomed, slowed and blocked, the top three by activity, the dashboard.
  expect(mails[0].text).toMatch(/Agents seen: 4\nWelcomed: 1\nSlowed: 1\nBlocked: 1/);
  expect(mails[0].text).toContain("Googlebot: 12 requests. Read your public pages. welcomed.");
  expect(mails[0].text).toContain("sqlmap: 7 requests");
  expect(mails[0].text).toContain("python-requests: 5 requests");
  expect(mails[0].text).not.toContain("curl: 2 requests");
  expect(mails[0].text).toContain("Open your live dashboard: https://instinct.example/forcefield/dashboard");
  expect(d.activity).toHaveBeenCalledWith("t1", "2026-10-26T09:00:00.000Z");
  expect(mails[0].text).toContain("/forcefield/unsubscribe?token=unsub-t1-qa%40thewolfpack.agency");
  expect(d.listTenantEvents).toHaveBeenCalledWith("t1", expect.any(String), expect.any(String));
  expect(d.track).toHaveBeenCalledWith("forcefield.tenant_first_evidence_sent", { tenant_id: "t1", site: "acme.com", kind: "first_hour", agents: 4, blocked: 1 });
  expect(d.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ site: "acme.com" }), expect.objectContaining({ status: "delivered", detail: "tenant" }));
});

it("a fully blocked tenant incident sends no immediate email (the daily summary covers it)", async () => {
  const { d, mails } = deps({ listTenantEvents: jest.fn(async () => [BLOCKED]), listConfirmedTenants: async () => [{ ...T, firstEvidenceAt: "x" }] });
  const r = await runTenantNotifications(d, NOT_DIGEST);
  expect(buildIncidents([BLOCKED])[0].route).toBe("digest");
  expect(r).toMatchObject({ alertsDispatched: 0, digestOnly: 1 });
  expect(d.claimAlert).not.toHaveBeenCalled();
  expect(mails).toEqual([]);
});

it("alerts only since the address was confirmed (when within the lookback)", async () => {
  const { d } = deps();
  await runTenantNotifications(d, NOT_DIGEST);
  expect((d.listTenantEvents as jest.Mock).mock.calls[0][1]).toBe(T.confirmedAt);
  const old = deps({ listConfirmedTenants: async () => [{ ...T, confirmedAt: "2026-01-01T00:00:00.000Z" }] });
  await runTenantNotifications(old.d, NOT_DIGEST);
  // Window-aligned lookback, the same floor the operator scan uses.
  expect((old.d.listTenantEvents as jest.Mock).mock.calls[0][1]).toBe("2026-10-25T06:00:00.000Z");
});

it("the first-hour email waits until the first real event has settled", async () => {
  const first = new Date(NOT_DIGEST.getTime() - FIRST_HOUR_SETTLE_MS + 60_000).toISOString();
  const early = deps({ firstEventAt: async () => first, listTenantEvents: async () => [] });
  expect((await runTenantNotifications(early.d, NOT_DIGEST)).firstEvidence).toBe(0);
  expect(early.d.claimFirstEvidence).not.toHaveBeenCalled();
  const later = new Date(NOT_DIGEST.getTime() + 120_000);
  expect((await runTenantNotifications(early.d, later)).firstEvidence).toBe(1);
});

it("the live first-event query excludes synthetic monitor traffic", async () => {
  const db = jest.requireMock("@/lib/db") as { query: jest.Mock };
  db.query.mockResolvedValueOnce({ rows: [{ at: null }] });
  const { liveTenantNotifyDeps } = await import("@/lib/forcefield-web/tenant-alerts");
  await liveTenantNotifyDeps().firstEventAt("t1");
  expect(db.query.mock.calls.at(-1)[0]).toMatch(/forcefield_tenant_id = \$1 AND COALESCE\(props->>'synthetic', ''\) <> 'true'/);
});

it("no first evidence without an event, and not again once sent", async () => {
  const none = deps({ firstEventAt: async () => null, listTenantEvents: async () => [] });
  expect((await runTenantNotifications(none.d, NOT_DIGEST)).firstEvidence).toBe(0);
  const sent = deps({ listConfirmedTenants: async () => [{ ...T, firstEvidenceAt: "x" }], listTenantEvents: async () => [] });
  expect((await runTenantNotifications(sent.d, NOT_DIGEST)).firstEvidence).toBe(0);
  expect(sent.mails).toEqual([]);
});

it("a provider failure releases the first-evidence claim; an allowlist refusal does not", async () => {
  const fail = deps({ send: jest.fn(async () => ({ delivered: false, reason: "no_mail_from" })), listTenantEvents: async () => [] });
  await runTenantNotifications(fail.d, NOT_DIGEST);
  expect(fail.d.releaseFirstEvidence).toHaveBeenCalledWith("t1");
  const blocked = deps({ send: jest.fn(async () => ({ delivered: false, reason: "recipient_not_allowlisted" })), listTenantEvents: async () => [] });
  const r = await runTenantNotifications(blocked.d, NOT_DIGEST);
  expect(blocked.d.releaseFirstEvidence).not.toHaveBeenCalled();
  expect(r.blocked).toBe(1);
});

it("a duplicate incident (claim taken) is not re-sent; alerts are capped per run", async () => {
  const dup = deps({ claimAlert: jest.fn(async () => false), listConfirmedTenants: async () => [{ ...T, firstEvidenceAt: "x" }] });
  expect((await runTenantNotifications(dup.d, NOT_DIGEST)).alertsDispatched).toBe(0);
  expect(dup.mails).toEqual([]);
  // Distinct sources far apart in time, so each is its own immediate incident.
  const many = Array.from({ length: MAX_ALERTS_PER_TENANT_RUN + 5 }, (_, i) => {
    const at = new Date(Date.parse("2026-10-26T06:00:00.000Z") + i * 600_000).toISOString();
    return { ...GROUP, fp: `fp${i}`, sig: `sig${i}`, firstAt: at, lastAt: at };
  });
  expect(buildIncidents(many).filter((i) => i.route === "immediate").length).toBeGreaterThan(MAX_ALERTS_PER_TENANT_RUN);
  const flood = deps({ listTenantEvents: async () => many, listConfirmedTenants: async () => [{ ...T, firstEvidenceAt: "x" }] });
  expect((await runTenantNotifications(flood.d, NOT_DIGEST)).alertsDispatched).toBe(MAX_ALERTS_PER_TENANT_RUN);
});

it("digest: only in its hour, only with traffic, once per claim", async () => {
  const base = { listConfirmedTenants: async () => [{ ...T, firstEvidenceAt: "x" }], listTenantEvents: async () => [] };
  const on = deps(base);
  const r = await runTenantNotifications(on.d, DIGEST);
  expect(r.digests).toBe(1);
  expect(on.mails[0].purpose).toBe("digest");
  expect(on.mails[0].subject).toContain("acme.com");
  expect(on.mails[0].text).toContain("/forcefield/unsubscribe?token=");
  expect(on.mails[0].text).not.toContain("/admin");

  const quiet = deps({ ...base, stats: jest.fn(async () => ({ ...STATS, agentsDetected: 0, hostile: 0 })) });
  expect((await runTenantNotifications(quiet.d, DIGEST)).digests).toBe(0);
  expect(quiet.d.claimDigest).not.toHaveBeenCalled();

  const claimed = deps({ ...base, claimDigest: jest.fn(async () => false) });
  expect((await runTenantNotifications(claimed.d, DIGEST)).digests).toBe(0);

  const off = deps(base);
  expect((await runTenantNotifications(off.d, NOT_DIGEST)).digests).toBe(0);
});

it("one tenant's failure does not stop the next; a listing failure returns an empty report", async () => {
  const two = deps({
    listConfirmedTenants: async () => [{ ...T, id: "bad", firstEvidenceAt: "x" }, { ...T, id: "t2", firstEvidenceAt: "x" }],
    listTenantEvents: jest.fn(async (id: string) => { if (id === "bad") throw new Error("x"); return [GROUP]; }),
  });
  const r = await runTenantNotifications(two.d, NOT_DIGEST);
  expect(r.alertsDelivered).toBe(1);
  expect(two.mails[0].tenantId).toBe("t2");
  const down = deps({ listConfirmedTenants: async () => { throw new Error("down"); } });
  expect(await runTenantNotifications(down.d, NOT_DIGEST)).toEqual({ tenants: 0, firstEvidence: 0, digestOnly: 0, alertsDispatched: 0, alertsDelivered: 0, digests: 0, blocked: 0 });
});
