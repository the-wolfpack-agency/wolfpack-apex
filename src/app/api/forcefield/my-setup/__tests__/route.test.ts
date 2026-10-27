/**
 * @jest-environment node
 *
 * Contract for /api/forcefield/my-setup. Asserts: unknown/missing token -> 401
 * (never another tenant's setup); a valid token -> 200 with the quick-start built
 * from THAT token + site and the connection signal; never 500 (connection
 * degrades). The libs are mocked so the contract needs no DB.
 */
import { NextRequest } from "next/server";

const mockResolve = jest.fn();
const mockQuickstart = jest.fn();
const mockConnection = jest.fn();
const mockById = jest.fn();
process.env.INSTINCT_JWT_SECRET = process.env.INSTINCT_JWT_SECRET || "test-secret-0123456789abcdef0123456789abcd";
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));

jest.mock("@/lib/forcefield-web/tenants", () => ({
  resolveTenantByToken: (...a: unknown[]) => mockResolve(...a),
  getActiveTenantById: (...a: unknown[]) => mockById(...a),
}));
jest.mock("@/lib/forcefield-web/tenant-quickstart", () => ({ buildTenantQuickstart: (...a: unknown[]) => mockQuickstart(...a) }));
jest.mock("@/lib/forcefield-web/public-stats", () => ({ getTenantConnection: (...a: unknown[]) => mockConnection(...a) }));

import { GET } from "../route";
import { mintDashboardSession } from "@/lib/forcefield-web/dashboard-session";

const TENANT = { id: "t-abc", name: "Acme", siteLabel: "acme.com" };
const req = (token?: string) =>
  new NextRequest("http://x/api/forcefield/my-setup", { headers: token ? { "x-forcefield-token": token } : {} });

beforeEach(() => jest.resetAllMocks());

it("401 on a missing/unknown token, and builds no setup", async () => {
  mockResolve.mockResolvedValueOnce(null);
  const res = await GET(req());
  expect(res.status).toBe(401);
  expect(mockQuickstart).not.toHaveBeenCalled();
  expect(mockConnection).not.toHaveBeenCalled();
});

it("200 with the quick-start (built from the caller's token + site) and the connection", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockQuickstart.mockReturnValueOnce({ token: "ff_real", cloudflareEnv: { SITE_ANALYTICS_INGEST_TOKEN: "ff_real" }, nextEnv: {}, nextSnippet: "x" });
  mockConnection.mockResolvedValueOnce({ connected: true, lastEventAt: "2026-10-07T00:00:00Z" });
  const res = await GET(req("ff_real"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.tenant).toEqual(TENANT);
  expect(body.quickstart.cloudflareEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_real");
  expect(body.connection).toEqual({ connected: true, lastEventAt: "2026-10-07T00:00:00Z" });
  // quick-start was built from the caller's exact token + tenant
  expect(mockQuickstart).toHaveBeenCalledWith(TENANT, "ff_real");
  expect(mockConnection).toHaveBeenCalledWith("t-abc");
});

it("reports not-connected when no traffic has arrived yet", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockQuickstart.mockReturnValueOnce({ token: "ff_real", cloudflareEnv: {}, nextEnv: {}, nextSnippet: "x" });
  mockConnection.mockResolvedValueOnce({ connected: false, lastEventAt: null });
  const res = await GET(req("ff_real"));
  const body = await res.json();
  expect(body.connection).toEqual({ connected: false, lastEventAt: null });
});

it("a dashboard session (WordPress path: the plugin holds the key) gets the connection but no quick-start", async () => {
  const id = "6f1d0c2a-1111-4222-8333-944455556666";
  mockById.mockResolvedValueOnce({ ...TENANT, id });
  mockConnection.mockResolvedValueOnce({ connected: true, everConnected: true, lastEventAt: "2026-10-26T00:00:00Z" });
  const res = await GET(req(mintDashboardSession(id)));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.quickstart).toBeNull();
  expect(body.connection.connected).toBe(true);
  expect(mockQuickstart).not.toHaveBeenCalled();
  expect(mockConnection).toHaveBeenCalledWith(id);
});
