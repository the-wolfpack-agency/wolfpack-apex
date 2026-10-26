/**
 * @jest-environment node
 *
 * Contract for PUBLIC POST /api/forcefield/onboarding/verify: 401 without / with
 * an unknown setup key, 409 already verified, 422 not verified (per-method
 * reasons, tracked), 429 with Retry-After, 200 verified (token once, audited
 * WITHOUT the token), 503 on provisioning errors.
 */
import { NextRequest } from "next/server";

const mockVerify = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/onboarding", () => ({ verifyOwnership: (...a: unknown[]) => mockVerify(...a), VERIFY_WINDOW_MS: 900_000 }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";

const post = (key?: string) => new NextRequest("http://x/api/forcefield/onboarding/verify", { method: "POST", headers: key ? { "x-forcefield-setup": key } : {} });

beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });

it("401 without a key and for an unknown key", async () => {
  expect((await POST(post())).status).toBe(401);
  expect(mockVerify).not.toHaveBeenCalled();
  mockVerify.mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
  expect((await POST(post("ffs_x"))).status).toBe(401);
});

it("409 when already verified", async () => {
  mockVerify.mockResolvedValueOnce({ ok: false, reason: "already_verified" });
  expect((await POST(post("ffs_k"))).status).toBe(409);
});

it("422 with per-method reasons when not verified, tracked", async () => {
  const attempts = [{ method: "dns_txt", reason: "no_txt_record" }, { method: "http_well_known", reason: "http_404" }];
  mockVerify.mockResolvedValueOnce({ ok: false, reason: "not_verified", attempts, requestId: "req-1" });
  const res = await POST(post("ffs_k"));
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ ok: false, error: "not_verified", attempts });
  expect(mockTrack).toHaveBeenCalledWith("forcefield.onboarding_ownership_failed", "anonymous", "public", { requestId: "req-1", reasons: "dns_txt:no_txt_record,http_well_known:http_404" });
});

it("429 with Retry-After", async () => {
  mockVerify.mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
  const res = await POST(post("ffs_k"));
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("900");
});

it("200 verified: token returned once, audit never carries it", async () => {
  mockVerify.mockResolvedValueOnce({
    ok: true, reason: "ok", requestId: "req-1", method: "dns_txt",
    tenant: { id: "t1", name: "acme.com", siteLabel: "acme.com", status: "active", createdAt: "x" },
    token: "ff_secret", quickstart: { cloudflareEnv: {} }, notify: { status: "pending", delivered: true, reason: "ok" },
  });
  const res = await POST(post("ffs_k"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, token: "ff_secret", method: "dns_txt", tenant: { id: "t1", siteLabel: "acme.com" }, notify: { status: "pending" } });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.onboarding_ownership_verified", resourceId: "req-1", afterState: { tenantId: "t1", method: "dns_txt" } });
  expect(JSON.stringify(mockAudit.mock.calls)).not.toContain("ff_secret");
  expect(JSON.stringify(mockTrack.mock.calls)).not.toContain("ff_secret");
});

it("503 on provisioning failure or error (never 500)", async () => {
  mockVerify.mockResolvedValueOnce({ ok: false, reason: "provision_failed" });
  expect((await POST(post("ffs_k"))).status).toBe(503);
  mockVerify.mockResolvedValueOnce({ ok: false, reason: "error" });
  expect((await POST(post("ffs_k"))).status).toBe(503);
});
