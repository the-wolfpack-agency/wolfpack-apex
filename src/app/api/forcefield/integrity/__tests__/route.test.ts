/** @jest-environment node */
import { NextRequest } from "next/server";
const mockCaller = jest.fn(); const mockRecord = jest.fn(); const mockRate = jest.fn();
jest.mock("@/lib/forcefield-web/ingest-auth", () => ({ resolveIngestCaller: (...a: unknown[]) => mockCaller(...a) }));
jest.mock("@/lib/forcefield/page-integrity", () => ({ recordIntegrityReports: (...a: unknown[]) => mockRecord(...a) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
import { POST } from "../route";

const req = (body: unknown) => new NextRequest("http://x/api/forcefield/integrity", { method: "POST", headers: { "x-ingest-token": "t", "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const REPORT = { directive: "script-src", blockedOrigin: "https://skim.example", page: "/checkout" };
beforeEach(() => { jest.clearAllMocks(); mockRate.mockResolvedValue({ ok: true }); mockRecord.mockResolvedValue(1); });

it("401 for an unknown token, and nothing stored", async () => {
  mockCaller.mockResolvedValue(null);
  expect((await POST(req({ site: "s", sig: "a", reports: [REPORT] }))).status).toBe(401);
  expect(mockRecord).not.toHaveBeenCalled();
});
it("200: a shared token names the site; the batch is stored for that site's scope", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  const res = await POST(req({ site: "aidanmulready", sig: "ab12", reports: [REPORT] }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, stored: 1 });
  expect(mockRecord).toHaveBeenCalledWith("site:aidanmulready", "ab12", [REPORT]);
});
it("a tenant token pins its own scope, whatever site the body names", async () => {
  mockCaller.mockResolvedValue({ kind: "tenant", tenant: { id: "11111111-2222-3333-4444-555555555555", siteLabel: "client" } });
  await POST(req({ site: "someone-else", sig: "ab12", reports: [REPORT] }));
  expect(mockRecord.mock.calls[0][0]).toBe("tenant:11111111-2222-3333-4444-555555555555");
});
it("the plugin's raw form is normalized here, with the session signature derived from the request shape", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  const raw = { "csp-report": { "document-uri": "https://wp.example/shop?x=1", "blocked-uri": "https://skim.example/a.js", "effective-directive": "script-src-elem" } };
  await POST(req({ site: "wpclient", raw, client: { userAgent: "Mozilla/5.0 Chrome/130", headerNames: ["host", "user-agent"] } }));
  const [scope, sig, reports] = mockRecord.mock.calls[0];
  expect(scope).toBe("site:wpclient");
  expect(sig).toMatch(/^[0-9a-f]{8}$/);
  expect(reports).toEqual([{ directive: "script-src", blockedOrigin: "https://skim.example", page: "/shop" }]);
});
it("400 without a site for a shared token; 429 when rate limited", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  expect((await POST(req({ sig: "a", reports: [REPORT] }))).status).toBe(400);
  mockRate.mockResolvedValueOnce({ ok: false });
  expect((await POST(req({ site: "s", sig: "a", reports: [REPORT] }))).status).toBe(429);
  expect((await POST(req("{not json"))).status).toBe(400);
});
