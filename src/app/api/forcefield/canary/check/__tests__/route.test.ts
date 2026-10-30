/** @jest-environment node */
import { NextRequest } from "next/server";
const mockCaller = jest.fn(); const mockReport = jest.fn(); const mockRate = jest.fn();
jest.mock("@/lib/forcefield-web/ingest-auth", () => ({ resolveIngestCaller: (...a: unknown[]) => mockCaller(...a) }));
jest.mock("@/lib/forcefield/canary-trip", () => ({ reportCanarySignIn: (...a: unknown[]) => mockReport(...a) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
import { POST } from "../route";

const req = (body: unknown) => new NextRequest("http://x/api/forcefield/canary/check", { method: "POST", headers: { "x-ingest-token": "t", "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockRate.mockResolvedValue({ ok: true }); });

it("401 for an unknown token", async () => {
  mockCaller.mockResolvedValue(null);
  expect((await POST(req({ username: "svc_sync_abcdef" }))).status).toBe(401);
  expect(mockReport).not.toHaveBeenCalled();
});
it("200 with the verdict, reported for the caller's site", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  mockReport.mockResolvedValue(true);
  const res = await POST(req({ site: "weekendwithporsche", username: "svc_sync_abcdef", path: "/admin/login", fp: "f", sig: "g" }));
  expect(await res.json()).toEqual({ ok: true, canary: true });
  expect(mockReport).toHaveBeenCalledWith({ site: "weekendwithporsche", username: "svc_sync_abcdef", path: "/admin/login", fp: "f", sig: "g" });
  mockReport.mockResolvedValue(false);
  expect(await (await POST(req({ site: "weekendwithporsche", username: "admin" }))).json()).toEqual({ ok: true, canary: false });
});
it("400 without a site for a shared token; 429 when rate limited", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  expect((await POST(req({ username: "svc_sync_abcdef" }))).status).toBe(400);
  mockRate.mockResolvedValueOnce({ ok: false });
  expect((await POST(req({ site: "s", username: "svc_sync_abcdef" }))).status).toBe(429);
});
