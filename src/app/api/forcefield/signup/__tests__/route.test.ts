/**
 * @jest-environment node
 *
 * Contract for the PUBLIC /api/forcefield/signup. Asserts: a valid new request is
 * 202 "received" and is audited (never a token), a tripped honeypot still answers
 * 202 so a bot learns nothing (and is NOT audited), invalid input is 400, a
 * rate-limited caller is 429 with Retry-After, and the response never carries a
 * token. The lib is mocked so the contract needs no database.
 */
import { NextRequest } from "next/server";

const mockCreate = jest.fn();
const mockRecordAudit = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/forcefield-web/signup", () => ({
  createSignupRequest: (...a: unknown[]) => mockCreate(...a),
  hashIp: () => "iphash",
  HONEYPOT_FIELD: "_hp_company",
  RATE_LIMIT_WINDOW_MS: 900_000,
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";

const post = (body: unknown) =>
  new NextRequest("http://x/api/forcefield/signup", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockRecordAudit.mockResolvedValue(undefined); });

it("202 'received' on a valid new request, audited, no token in the response", async () => {
  mockCreate.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1" });
  const res = await POST(post({ name: "Dana", email: "dana@acme.com", siteUrl: "acme.com" }));
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body).toEqual({ ok: true, status: "received" });
  expect(JSON.stringify(body)).not.toMatch(/token|ff_/i);
  expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  expect(mockRecordAudit.mock.calls[0][0].action).toBe("forcefield.signup_requested");
  expect(mockTrack).toHaveBeenCalledWith("forcefield.signup_requested", "anonymous", "public", { requestId: "req-1" });
});

it("202 on a tripped honeypot, but NOT audited (a bot learns nothing)", async () => {
  mockCreate.mockResolvedValueOnce({ ok: false, reason: "honeypot" });
  const res = await POST(post({ name: "x", email: "x@x.com", siteUrl: "x.com", _hp_company: "bot" }));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "received" });
  expect(mockRecordAudit).not.toHaveBeenCalled();
});

it("202 on a duplicate open request (same success shape)", async () => {
  mockCreate.mockResolvedValueOnce({ ok: true, reason: "duplicate" });
  const res = await POST(post({ name: "Dana", email: "dana@acme.com", siteUrl: "acme.com" }));
  expect(res.status).toBe(202);
  expect(mockRecordAudit).not.toHaveBeenCalled(); // only a brand-new requestId is audited
});

it("400 on invalid input", async () => {
  mockCreate.mockResolvedValueOnce({ ok: false, reason: "invalid" });
  const res = await POST(post({ name: "", email: "bad", siteUrl: "" }));
  expect(res.status).toBe(400);
});

it("429 with a window-length Retry-After when rate limited", async () => {
  mockCreate.mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
  const res = await POST(post({ name: "Dana", email: "dana@acme.com", siteUrl: "acme.com" }));
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("900"); // RATE_LIMIT_WINDOW_MS / 1000
});
