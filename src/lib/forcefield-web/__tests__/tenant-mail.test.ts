/** @jest-environment node */
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/mail/send-via-graph", () => ({ sendViaGraph: jest.fn() }));

import { sendForcefieldTenantMail } from "@/lib/forcefield-web/tenant-mail";

const mail = (to: string) => ({ to, subject: "s", text: "t", html: "h", purpose: "confirm" as const, tenantId: "t1" });

beforeEach(() => { jest.clearAllMocks(); delete process.env.FORCEFIELD_RECIPIENT_DOMAINS; });

it("refuses a non-allowlisted address without calling the sender, and records the block", async () => {
  const send = jest.fn();
  expect(await sendForcefieldTenantMail(mail("owner@client.example"), send)).toEqual({ delivered: false, reason: "recipient_not_allowlisted" });
  expect(send).not.toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith("forcefield.tenant_mail_blocked", "system", "forcefield", { purpose: "confirm", tenant_id: "t1", recipient_domain: "client.example" });
});

it("sends an allowlisted address via Graph with the Forcefield sender name and records the outcome", async () => {
  const send = jest.fn(async () => ({ delivered: true, reason: "ok" as const }));
  expect(await sendForcefieldTenantMail(mail("qa@thewolfpack.agency"), send)).toEqual({ delivered: true, reason: "ok" });
  expect(send).toHaveBeenCalledWith({ to: "qa@thewolfpack.agency", subject: "s", text: "t", html: "h", fromName: "OGIAM Forcefield" });
  expect(mockTrack).toHaveBeenCalledWith("forcefield.tenant_mail_sent", "system", "forcefield", { purpose: "confirm", tenant_id: "t1", delivered: true, reason: "ok" });
});

it("passes a Graph failure reason through and never throws", async () => {
  expect(await sendForcefieldTenantMail(mail("qa@thewolfpack.agency"), jest.fn(async () => ({ delivered: false, reason: "scope_missing" as const })))).toEqual({ delivered: false, reason: "scope_missing" });
  const r = await sendForcefieldTenantMail(mail("qa@thewolfpack.agency"), jest.fn(async () => { throw new Error("boom"); }));
  expect(r.delivered).toBe(false);
  expect(r.reason).toMatch(/^send_threw/);
});
