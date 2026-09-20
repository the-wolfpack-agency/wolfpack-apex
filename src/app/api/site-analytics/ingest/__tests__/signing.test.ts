/** @jest-environment node */
import { NextRequest } from "next/server";
const recordSiteEvent = jest.fn();
const verifyIngestSignature = jest.fn();
const ingestSigningEnforced = jest.fn();
jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a), isSiteEventType: (t: unknown) => t === "site.agent_welcomed" }));
jest.mock("@/lib/forcefield/ingest-signing", () => ({ ingestSigningEnforced: (...a: unknown[]) => ingestSigningEnforced(...a), verifyIngestSignature: (...a: unknown[]) => verifyIngestSignature(...a) }));
jest.mock("@/lib/forcefield/principal", () => ({ verifyPresentedDelegation: async () => ({ status: "absent", scopes: [], reason: "" }), getDelegationIssuer: async () => null, consumeDelegationJti: async () => true }));

import { POST, _resetIngestRateLimit } from "@/app/api/site-analytics/ingest/route";
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/site-analytics/ingest", { method: "POST", headers: { "content-type": "application/json", "x-ingest-token": "tok", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "tok";
  [recordSiteEvent, verifyIngestSignature, ingestSigningEnforced].forEach((m) => m.mockReset());
  _resetIngestRateLimit();
});

it("with signing enforced, rejects an unsigned batch (401) even with a valid token", async () => {
  ingestSigningEnforced.mockReturnValue(true);
  verifyIngestSignature.mockResolvedValue({ ok: false, reason: "unsigned" });
  const res = await POST(req({ type: "site.agent_welcomed" }));
  expect(res.status).toBe(401);
  expect(recordSiteEvent).not.toHaveBeenCalled();
});

it("with signing enforced, accepts a correctly-signed batch", async () => {
  ingestSigningEnforced.mockReturnValue(true);
  verifyIngestSignature.mockResolvedValue({ ok: true });
  const res = await POST(req({ type: "site.agent_welcomed" }, { "x-ingest-source": "mkt", "x-ingest-timestamp": "1", "x-ingest-signature": "sig" }));
  expect(res.status).toBe(200);
  expect(recordSiteEvent).toHaveBeenCalled();
});

it("with signing OFF, behaves as before (token-only, no signature needed)", async () => {
  ingestSigningEnforced.mockReturnValue(false);
  const res = await POST(req({ type: "site.agent_welcomed" }));
  expect(res.status).toBe(200);
  expect(verifyIngestSignature).not.toHaveBeenCalled();
});
