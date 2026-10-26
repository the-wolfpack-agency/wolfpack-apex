/**
 * @jest-environment node
 *
 * Contract for PUBLIC /api/forcefield/onboarding (step 1 + state):
 * POST 201 self-serve (setup key + ownership instructions, audited, never an
 * ingest token), 202 request (build phase fallback, audited as a request), 202
 * honeypot (not audited), 400 invalid, 429 with Retry-After, 503 unavailable.
 * GET 200 state, 401 without / with an unknown setup key, 503.
 */
import { NextRequest } from "next/server";

const mockStart = jest.fn();
const mockState = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/onboarding", () => ({
  startForcefieldOnboarding: (...a: unknown[]) => mockStart(...a),
  getOnboardingState: (...a: unknown[]) => mockState(...a),
  START_WINDOW_MS: 900_000,
}));
jest.mock("@/lib/forcefield-web/signup", () => ({ hashIp: () => "iphash" }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST, GET } from "../route";

const post = (body: unknown) => new NextRequest("http://x/api/forcefield/onboarding", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (key?: string) => new NextRequest("http://x/api/forcefield/onboarding", { headers: key ? { "x-forcefield-setup": key } : {} });

beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });

it("201 self-serve: setup key + instructions, audited, no ingest token", async () => {
  mockStart.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1", setupKey: "ffs_k", site: "acme.com", email: "qa@thewolfpack.agency", ownership: [{ method: "dns_txt", value: "ogiam-site-verification=x" }] });
  const res = await POST(post({ siteUrl: "acme.com", email: "qa@thewolfpack.agency" }));
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, mode: "self_serve", requestId: "req-1", setupKey: "ffs_k", site: "acme.com" });
  expect(JSON.stringify(body)).not.toMatch(/"ff_/);
  expect(mockStart.mock.calls[0][0]).toEqual({ raw: { siteUrl: "acme.com", email: "qa@thewolfpack.agency" }, ipHash: "iphash" });
  expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.onboarding_started", resourceId: "req-1" });
  expect(mockTrack).toHaveBeenCalledWith("forcefield.onboarding_started", "anonymous", "public", { requestId: "req-1", email_domain: "thewolfpack.agency" });
});

it("202 request: a non-allowlisted address is filed for review, nothing more returned", async () => {
  mockStart.mockResolvedValueOnce({ ok: true, reason: "request", requestId: "req-2" });
  const res = await POST(post({ siteUrl: "acme.com", email: "dana@acme.com" }));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, mode: "request" });
  expect(mockAudit.mock.calls[0][0].action).toBe("forcefield.signup_requested");
});

it("202 on a honeypot, not audited", async () => {
  mockStart.mockResolvedValueOnce({ ok: false, reason: "honeypot" });
  const res = await POST(post({ siteUrl: "a.com", email: "a@a.com", _hp_company: "bot" }));
  expect(res.status).toBe(202);
  expect(mockAudit).not.toHaveBeenCalled();
});

it("400 on invalid input and on a non-object body", async () => {
  mockStart.mockResolvedValueOnce({ ok: false, reason: "invalid" });
  expect((await POST(post({ siteUrl: "nope" }))).status).toBe(400);
  expect((await POST(post("[1,2]"))).status).toBe(400);
});

it("429 with Retry-After when rate limited", async () => {
  mockStart.mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
  const res = await POST(post({ siteUrl: "a.com", email: "a@thewolfpack.agency" }));
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("900");
});

it("503 when the store is unavailable (never 500)", async () => {
  mockStart.mockResolvedValueOnce({ ok: false, reason: "error" });
  expect((await POST(post({ siteUrl: "a.com", email: "a@thewolfpack.agency" }))).status).toBe(503);
});

it("GET 401 without a setup key, 401 for an unknown key, 200 with state, 503 on error", async () => {
  expect((await GET(get())).status).toBe(401);
  mockState.mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
  expect((await GET(get("ffs_bad"))).status).toBe(401);
  mockState.mockResolvedValueOnce({ ok: true, state: { requestId: "req-1", site: "acme.com", step: "verify" } });
  const ok = await GET(get("ffs_k"));
  expect(ok.status).toBe(200);
  expect((await ok.json()).state.site).toBe("acme.com");
  expect(mockState).toHaveBeenLastCalledWith("ffs_k");
  mockState.mockResolvedValueOnce({ ok: false, reason: "error" });
  expect((await GET(get("ffs_k"))).status).toBe(503);
});
