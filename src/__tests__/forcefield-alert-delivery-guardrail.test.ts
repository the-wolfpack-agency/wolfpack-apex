/** @jest-environment node */
/**
 * BUILD-PHASE GUARDRAIL: no Forcefield message may reach anyone outside the
 * recipient allowlist (FORCEFIELD_RECIPIENT_DOMAINS, default Wolfpack domains,
 * src/lib/forcefield-web/recipient-allowlist.ts).
 *
 * This replaces the earlier "no tenant delivery path at all" guard. Tenant
 * delivery now exists (onboarding confirmation, first evidence, a tenant's
 * alerts and digest), and every one of those sends goes through ONE guarded
 * sender, sendForcefieldTenantMail (tenant-mail.ts), which refuses a
 * non-allowlisted address before the mail provider is called. This test fails
 * the build if:
 *   1. any Forcefield source other than alerts.ts (the Wolfpack operator path)
 *      and tenant-mail.ts (the guarded tenant sender) imports a mail or
 *      notification sender (an unguarded delivery path);
 *   2. the alert template is rendered anywhere but alerts.ts (operator) and
 *      tenant-alerts.ts (tenant), or the tenant version anywhere but
 *      tenant-alerts.ts;
 *   3. the operator path stops sending exactly once over alertRecipientEmails();
 *   4. the guarded sender, or any tenant delivery path driven end to end, hands
 *      a non-allowlisted address (look-alikes, subdomains, malformed) to the
 *      mail provider, under the default setting or a narrowed one;
 *   5. the operator recipient list (alertRecipientEmails) can return an address
 *      the allowlist refuses, whatever FORCEFIELD_ALERT_RECIPIENT_EMAIL holds.
 * Opening delivery to clients is the operator setting FORCEFIELD_RECIPIENT_DOMAINS
 * (see docs/forcefield/self-serve-onboarding.md), not an edit to this file.
 */
import fs from "node:fs";
import path from "node:path";

const mockFanout = jest.fn<Promise<{ recipientCount: number; skipped: number }>, [{ recipientEmails?: string[] }]>(async () => ({ recipientCount: 1, skipped: 0 }));
const mockSendViaGraph = jest.fn<Promise<{ delivered: boolean; reason: string }>, [{ to: string }]>(async () => ({ delivered: true, reason: "ok" }));
jest.mock("@/lib/notifications/team-fanout", () => ({ fanoutToTeam: (i: { recipientEmails?: string[] }) => mockFanout(i) }));
jest.mock("@/lib/mail/send-via-graph", () => ({ sendViaGraph: (a: { to: string }) => mockSendViaGraph(a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: jest.fn(async () => {}), trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: jest.fn(async () => ({ ok: true, remaining: 5 })) }));

import { deliverForcefieldAlert, alertFromSignal, alertFromIncident, alertRecipientEmails } from "@/lib/forcefield-web/alerts";
import { buildDigest, buildIncidents } from "@/lib/forcefield-web/incidents";
import { sendForcefieldTenantMail } from "@/lib/forcefield-web/tenant-mail";
import { isRecipientAllowed } from "@/lib/forcefield-web/recipient-allowlist";
import { runTenantNotifications, type TenantNotifyDeps } from "@/lib/forcefield-web/tenant-alerts";
import { setNotifyEmail } from "@/lib/forcefield-web/tenant-notify";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const SOURCES = walk(SRC).map((p) => ({ file: rel(p), text: fs.readFileSync(p, "utf-8") }));
const textOf = (f: string) => SOURCES.find((s) => s.file === f)!.text;

const OPERATOR_DELIVERY = "src/lib/forcefield-web/alerts.ts";
const TENANT_SENDER = "src/lib/forcefield-web/tenant-mail.ts";
const TENANT_ALERTS = "src/lib/forcefield-web/tenant-alerts.ts";
const TEMPLATE = "src/lib/forcefield-web/alert-email.ts";
// A sender is an import or call of a mail/notification path. The Resend SDK is
// matched by its import/constructor, not the English word "resend" (a "Resend
// the email" button is not a sender).
const SENDERS = /sendViaGraph|fanoutToTeam|@\/lib\/notifications\/|send-invite|send-password-reset|from\s+["']resend["']|new\s+Resend\s*\(|sendMail\b/i;
const isForcefield = (f: string) => /\/(forcefield|forcefield-web)(\/|-)/.test(f) || /\/forcefield[^/]*\//.test(f);

const ADDRESSES_OUTSIDE = [
  "owner@client-site.example",
  "a@thewolfpack.agency.evil.com",
  "a@sub.thewolfpack.agency",
  "a@notthewolfpack.agency",
  "a@wolfpack.dev",
  "thewolfpack.agency",
  "",
];

afterEach(() => {
  delete process.env.FORCEFIELD_RECIPIENT_DOMAINS;
  mockSendViaGraph.mockClear();
  mockFanout.mockClear();
});

describe("only guarded Forcefield delivery paths exist", () => {
  it("only alerts.ts (operator) and tenant-mail.ts (guarded tenant sender) import a mail or notification sender", () => {
    const offenders = SOURCES.filter((s) => isForcefield(s.file) && s.file !== OPERATOR_DELIVERY && s.file !== TENANT_SENDER && SENDERS.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("the alert template is rendered only by the operator path and the tenant path", () => {
    const users = SOURCES.filter((s) => s.file !== TEMPLATE && /renderForcefieldAlertEmail\s*\(/.test(s.text)).map((s) => s.file).sort();
    expect(users).toEqual([OPERATOR_DELIVERY, TENANT_ALERTS].sort());
  });

  it("the tenant (client-facing) version is rendered only by tenant-alerts.ts, and the operator path stays operator-only", () => {
    const tenantRender = SOURCES.filter((s) => s.file !== TEMPLATE && /audience\s*:\s*["'`]tenant["'`]/.test(s.text)).map((s) => s.file);
    expect(tenantRender).toEqual([TENANT_ALERTS]);
    const delivery = textOf(OPERATOR_DELIVERY);
    expect(delivery).toMatch(/audience:\s*"operator"/);
    expect(delivery).not.toMatch(/["'`]tenant["'`]/);
  });

  it("the operator path sends mail in exactly one place, over alertRecipientEmails()", () => {
    const delivery = textOf(OPERATOR_DELIVERY);
    expect(delivery.match(/sendViaGraph\(/g)).toHaveLength(1);
    expect(delivery).toMatch(/const recipients = alertRecipientEmails\(\);/);
    expect(delivery).toMatch(/for \(const to of recipients\)/);
    expect(delivery).toMatch(/recipientEmails: recipients,/);
  });

  it("the guarded sender checks the allowlist before its single send", () => {
    const src = textOf(TENANT_SENDER);
    const check = src.indexOf("if (!isRecipientAllowed(mail.to))");
    const send = src.indexOf("await send(");
    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
    expect(src.match(/await send\(/g)).toHaveLength(1);
  });

  it("every tenant email is built by a file that sends only through sendForcefieldTenantMail", () => {
    const builders = SOURCES.filter((s) => isForcefield(s.file) && /render(Confirm|FirstEvidence|TenantDigest)Email\s*\(|renderTenantAlert\s*\(/.test(s.text) && !s.file.endsWith("tenant-email.ts"));
    expect(builders.map((b) => b.file).sort()).toEqual(["src/lib/forcefield-web/tenant-alerts.ts", "src/lib/forcefield-web/tenant-notify.ts"]);
    for (const b of builders) expect([b.file, /sendForcefieldTenantMail/.test(b.text)]).toEqual([b.file, true]);
  });
});

describe("the guarded sender never hands a non-allowlisted address to the provider", () => {
  const mail = (to: string) => ({ to, subject: "s", text: "t", html: "<p>h</p>", purpose: "alert" as const, tenantId: "t1" });

  it.each(ADDRESSES_OUTSIDE)("default allowlist refuses %p", async (to) => {
    const r = await sendForcefieldTenantMail(mail(to));
    expect(r).toEqual({ delivered: false, reason: "recipient_not_allowlisted" });
    expect(mockSendViaGraph).not.toHaveBeenCalled();
  });

  it("delivers to an allowlisted Wolfpack address", async () => {
    const r = await sendForcefieldTenantMail(mail("ops@thewolfpack.agency"));
    expect(r.delivered).toBe(true);
    expect(mockSendViaGraph.mock.calls.map((c) => c[0].to)).toEqual(["ops@thewolfpack.agency"]);
  });

  it("a narrowed setting refuses everything outside it; '*' is the single switch that opens delivery", async () => {
    process.env.FORCEFIELD_RECIPIENT_DOMAINS = "pilot.example";
    expect((await sendForcefieldTenantMail(mail("ops@thewolfpack.agency"))).delivered).toBe(false);
    expect((await sendForcefieldTenantMail(mail("x@pilot.example"))).delivered).toBe(true);
    process.env.FORCEFIELD_RECIPIENT_DOMAINS = "*";
    expect((await sendForcefieldTenantMail(mail("owner@client-site.example"))).delivered).toBe(true);
    expect((await sendForcefieldTenantMail(mail("not-an-email"))).delivered).toBe(false);
  });
});

describe("tenant delivery paths, driven end to end, stay inside the allowlist", () => {
  function deps(email: string): TenantNotifyDeps {
    return {
      listConfirmedTenants: async () => [{ id: "t1", name: "Client", siteLabel: "client-site.example", email, confirmedAt: "2026-10-26T00:00:00.000Z", firstEvidenceAt: null }],
      firstEventAt: async () => "2026-10-26T01:00:00.000Z",
      claimFirstEvidence: async () => true,
      releaseFirstEvidence: async () => {},
      stats: async () => ({ rangeDays: 1, agentsDetected: 5, welcomed: 1, trapped: 1, probed: 1, payloads: 1, hostile: 3, sitesProtected: 1, attacks: [] }),
      // An unblocked request on the tenant's site: an "immediate" incident.
      listTenantEvents: async () => [{
        kind: "payload_attack", site: "client-site.example", attackClass: "xss", windowStart: "2026-10-26T00:00:00.000Z",
        fp: "f", sig: "s", path: "/x", country: "US", hosting: "", clientType: "", agent: "", network: "",
        outcome: "recorded", posture: "monitor", reasonKind: "payload", count: 2, firstAt: "2026-10-26T12:00:00.000Z", lastAt: "2026-10-26T12:00:01.000Z",
      }],
      claimAlert: async () => true,
      recordOutcome: async () => {},
      claimDigest: async () => true,
      send: (m) => sendForcefieldTenantMail(m),
      track: async () => {},
      baseUrl: "https://instinct.example",
      unsubscribeToken: () => "unsub",
    };
  }

  it("first evidence, alerts and the digest to a non-allowlisted tenant address never reach the provider", async () => {
    const report = await runTenantNotifications(deps("owner@client-site.example"), new Date("2026-10-26T13:05:00.000Z"));
    expect(mockSendViaGraph).not.toHaveBeenCalled();
    expect(report.blocked).toBeGreaterThanOrEqual(3);
  });

  it("the same run to a Wolfpack address does reach the provider (the guard is not vacuous)", async () => {
    await runTenantNotifications(deps("qa@thewolfpack.agency"), new Date("2026-10-26T13:05:00.000Z"));
    expect(mockSendViaGraph.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(mockSendViaGraph.mock.calls.map((c) => c[0].to))).toEqual(new Set(["qa@thewolfpack.agency"]));
  });

  it("setting a non-allowlisted alert address is refused before any email is built", async () => {
    const q = jest.fn(async () => [{ site_label: "client-site.example" }]);
    const r = await setNotifyEmail("t1", "owner@client-site.example", { q: q as never, limiter: async () => ({ allowed: true }) });
    expect(r.reason).toBe("not_allowed");
    expect(q).not.toHaveBeenCalled();
    expect(mockSendViaGraph).not.toHaveBeenCalled();
  });
});

describe("the operator path reaches the Wolfpack list only", () => {
  const ORIG = process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL;
  afterAll(() => {
    if (ORIG === undefined) delete process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL;
    else process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = ORIG;
  });

  it("the default operator recipients are all on the allowlist", () => {
    delete process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL;
    const list = alertRecipientEmails();
    expect(list.length).toBeGreaterThan(0);
    for (const to of list) expect([to, isRecipientAllowed(to)]).toEqual([to, true]);
  });

  it("a non-allowlisted operator address is dropped before any send (the operator list obeys the allowlist too)", async () => {
    process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = "sec-a@thewolfpack.agency, owner@client-site.example, a@thewolfpack.agency.evil.com";
    expect(alertRecipientEmails()).toEqual(["sec-a@thewolfpack.agency"]);
    mockSendViaGraph.mockClear();
    mockFanout.mockClear();
    await deliverForcefieldAlert(alertFromSignal({
      kind: "payload_attack", site: "client-site.example", attackClass: "xss", windowStart: "2026-10-26T06:00:00.000Z", fpCount: 0, samplePath: "/", count: 1,
    }));
    expect(mockSendViaGraph.mock.calls.map((c) => c[0].to)).toEqual(["sec-a@thewolfpack.agency"]);
    expect(mockFanout.mock.calls[0][0].recipientEmails).toEqual(["sec-a@thewolfpack.agency"]);
    process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = "owner@client-site.example";
    expect(alertRecipientEmails()).toEqual([]);
  });

  it("whatever the alert carries (a tenant site, an address in a field), mail and in-app go only to the configured list", async () => {
    process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = "sec-a@thewolfpack.agency, sec-b@thewolfpack.agency";
    const alert = alertFromSignal({
      kind: "payload_attack", site: "client-site.example", attackClass: "sql_injection", windowStart: "2026-10-26T06:00:00.000Z",
      fpCount: 0, samplePath: "/?contact=owner@client-site.example", count: 1,
    });
    alert.metadata = { ...alert.metadata, contact: "owner@client-site.example" };
    await deliverForcefieldAlert(alert);
    const allowed = alertRecipientEmails();
    expect(allowed).toEqual(["sec-a@thewolfpack.agency", "sec-b@thewolfpack.agency"]);
    expect(mockSendViaGraph.mock.calls.map((c) => c[0].to)).toEqual(allowed);
    expect(mockFanout).toHaveBeenCalledTimes(1);
    expect(mockFanout.mock.calls[0][0].recipientEmails).toEqual(allowed);
  });

  it("the daily digest and grouped incidents take the same path to the same list", async () => {
    process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = "sec-a@thewolfpack.agency";
    mockSendViaGraph.mockClear();
    mockFanout.mockClear();
    const g = {
      kind: "payload_attack" as const, site: "client-site.example", attackClass: "xss", windowStart: "2026-10-26T12:00:00.000Z",
      fp: "f", sig: "s", path: "/?to=owner@client-site.example", country: "US", hosting: "", clientType: "", agent: "", network: "",
      outcome: "blocked" as const, posture: "enforce", reasonKind: "payload", count: 2, firstAt: "2026-10-26T14:00:00.000Z", lastAt: "2026-10-26T14:00:01.000Z",
    };
    const digest = buildDigest(buildIncidents([g]), { etDate: "2026-10-27", start: new Date("2026-10-26T12:00:00Z"), end: new Date("2026-10-27T12:00:00Z") });
    await deliverForcefieldAlert({ kind: "alert_digest", dedupeKey: "d", title: "t", body: "b", digest });
    const [inc] = buildIncidents([{ ...g, outcome: "recorded" }]);
    await deliverForcefieldAlert(alertFromIncident(inc));
    expect(mockSendViaGraph.mock.calls.map((c) => c[0].to)).toEqual(["sec-a@thewolfpack.agency", "sec-a@thewolfpack.agency"]);
    expect(mockFanout.mock.calls.map((c) => c[0].recipientEmails)).toEqual([["sec-a@thewolfpack.agency"], ["sec-a@thewolfpack.agency"]]);
  });
});
