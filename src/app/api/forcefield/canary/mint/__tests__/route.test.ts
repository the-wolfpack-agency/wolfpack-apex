/** @jest-environment node */
import { NextRequest } from "next/server";
const mockCaller = jest.fn(); const mockMint = jest.fn(); const mockRate = jest.fn();
jest.mock("@/lib/forcefield-web/ingest-auth", () => ({ resolveIngestCaller: (...a: unknown[]) => mockCaller(...a) }));
jest.mock("@/lib/forcefield/canary-login", () => ({ mintCanaryLogin: (...a: unknown[]) => mockMint(...a) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
import { POST } from "../route";

const req = (body: unknown) => new NextRequest("http://x/api/forcefield/canary/mint", { method: "POST", headers: { "x-ingest-token": "t", "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockRate.mockResolvedValue({ ok: true }); });

it("401 for an unknown token; nothing minted", async () => {
  mockCaller.mockResolvedValue(null);
  expect((await POST(req({ decoy: "/_ff/x", sig: "s" }))).status).toBe(401);
  expect(mockMint).not.toHaveBeenCalled();
});
it("400 for a missing decoy or session, or a shared token without a site", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  expect((await POST(req({ decoy: "/_ff/x", sig: "s" }))).status).toBe(400); // no site
  expect((await POST(req({ site: "ogiam.com", decoy: "not-a-path", sig: "s" }))).status).toBe(400);
  expect((await POST(req({ site: "ogiam.com", decoy: "/_ff/x", sig: "bad sig!" }))).status).toBe(400);
  expect(mockMint).not.toHaveBeenCalled();
});
it("a tenant's token mints for its own site (the body's site is ignored)", async () => {
  mockCaller.mockResolvedValue({ kind: "tenant", tenant: { id: "t1", siteLabel: "acme" }, edge: false });
  mockMint.mockResolvedValue({ username: "svc_sync_abcdef", password: "p" });
  const res = await POST(req({ site: "someone-else", decoy: "/_ff/x", sig: "s1" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, username: "svc_sync_abcdef", password: "p" });
  expect(mockMint).toHaveBeenCalledWith({ site: "acme", decoy: "/_ff/x", sig: "s1" });
});
it("429 when rate limited, 503 when the store fails", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  mockRate.mockResolvedValueOnce({ ok: false });
  expect((await POST(req({ site: "ogiam.com", decoy: "/_ff/x", sig: "s" }))).status).toBe(429);
  mockMint.mockResolvedValue(null);
  expect((await POST(req({ site: "ogiam.com", decoy: "/_ff/x", sig: "s" }))).status).toBe(503);
});
