/** @jest-environment node */
/**
 * BUILD-PHASE GUARDRAIL: no Forcefield message may reach a client or tenant.
 *
 * Forcefield alerts go to the Wolfpack security list (alertRecipientEmails,
 * FORCEFIELD_ALERT_RECIPIENT_EMAIL) and nowhere else. The client-facing
 * ("tenant") version of the alert template exists for previews only. This test
 * fails the build if:
 *   1. any Forcefield source file other than forcefield-web/alerts.ts imports a
 *      mail or notification sender (a second delivery path);
 *   2. any production source renders the tenant version of the template;
 *   3. the template is rendered anywhere but the one delivery path;
 *   4. deliverForcefieldAlert sends to, or notifies, anyone other than
 *      alertRecipientEmails(), whatever the alert carries.
 * Lifting the build-phase rule is a deliberate change to this file.
 */
import fs from "node:fs";
import path from "node:path";

const mockFanout = jest.fn<Promise<{ recipientCount: number; skipped: number }>, [{ recipientEmails?: string[] }]>(async () => ({ recipientCount: 1, skipped: 0 }));
const mockSendViaGraph = jest.fn<Promise<{ delivered: boolean; reason: string }>, [{ to: string }]>(async () => ({ delivered: true, reason: "ok" }));
jest.mock("@/lib/notifications/team-fanout", () => ({ fanoutToTeam: (i: { recipientEmails?: string[] }) => mockFanout(i) }));
jest.mock("@/lib/mail/send-via-graph", () => ({ sendViaGraph: (a: { to: string }) => mockSendViaGraph(a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: jest.fn(async () => {}), trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));

import { deliverForcefieldAlert, alertFromSignal, alertRecipientEmails } from "@/lib/forcefield-web/alerts";

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

const ALERT_DELIVERY = "src/lib/forcefield-web/alerts.ts";
const TEMPLATE = "src/lib/forcefield-web/alert-email.ts";
const SENDERS = /sendViaGraph|fanoutToTeam|@\/lib\/notifications\/|send-invite|send-password-reset|\bresend\b|sendMail\b/i;
const isForcefield = (f: string) => /\/(forcefield|forcefield-web)(\/|-)/.test(f) || /\/forcefield[^/]*\//.test(f);

describe("no second Forcefield delivery path", () => {
  it("only forcefield-web/alerts.ts imports a mail or notification sender", () => {
    const offenders = SOURCES.filter((s) => isForcefield(s.file) && s.file !== ALERT_DELIVERY && SENDERS.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("the alert template is rendered only by the delivery path (and defined in the template file)", () => {
    const users = SOURCES.filter((s) => s.file !== TEMPLATE && /renderForcefieldAlertEmail\s*\(/.test(s.text)).map((s) => s.file);
    expect(users).toEqual([ALERT_DELIVERY]);
  });

  it("no production source renders the tenant (client-facing) version", () => {
    const tenantRender = SOURCES.filter((s) => s.file !== TEMPLATE && /audience\s*:\s*["'`]tenant["'`]/.test(s.text)).map((s) => s.file);
    expect(tenantRender).toEqual([]);
    const delivery = SOURCES.find((s) => s.file === ALERT_DELIVERY)!.text;
    expect(delivery).toMatch(/audience:\s*"operator"/);
    expect(delivery).not.toMatch(/["'`]tenant["'`]/);
  });

  it("the delivery path sends mail in exactly one place, over alertRecipientEmails()", () => {
    const delivery = SOURCES.find((s) => s.file === ALERT_DELIVERY)!.text;
    expect(delivery.match(/sendViaGraph\(/g)).toHaveLength(1);
    expect(delivery).toMatch(/const recipients = alertRecipientEmails\(\);/);
    expect(delivery).toMatch(/for \(const to of recipients\)/);
    expect(delivery).toMatch(/recipientEmails: recipients,/);
  });
});

describe("deliverForcefieldAlert reaches the Wolfpack list only", () => {
  const ORIG = process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL;
  afterAll(() => {
    if (ORIG === undefined) delete process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL;
    else process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = ORIG;
  });

  it("whatever the alert carries (a tenant site, an address in a field), mail and in-app go only to the configured list", async () => {
    process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL = "sec-a@wolfpack.example, sec-b@wolfpack.example";
    const alert = alertFromSignal({
      kind: "payload_attack", site: "client-site.example", attackClass: "sql_injection", windowStart: "2026-10-26T06:00:00.000Z",
      fpCount: 0, samplePath: "/?contact=owner@client-site.example", count: 1,
    });
    alert.metadata = { ...alert.metadata, contact: "owner@client-site.example" };
    await deliverForcefieldAlert(alert);
    const allowed = alertRecipientEmails();
    expect(allowed).toEqual(["sec-a@wolfpack.example", "sec-b@wolfpack.example"]);
    expect(mockSendViaGraph.mock.calls.map((c) => c[0].to)).toEqual(allowed);
    expect(mockFanout).toHaveBeenCalledTimes(1);
    expect(mockFanout.mock.calls[0][0].recipientEmails).toEqual(allowed);
  });
});
