/**
 * @jest-environment node
 *
 * Contract for /api/forcefield/my-stats - the client-facing, token-authenticated
 * stats endpoint. Asserts the ISOLATION boundary: no/unknown token -> 401 (never
 * another tenant's data), a valid token -> 200 with the stats scoped to THAT
 * tenant's id, and that the stats helper is asked for exactly that tenant. The
 * libs are mocked so the contract needs no database.
 */
import { NextRequest } from "next/server";

const mockResolve = jest.fn();
const mockStats = jest.fn();
const mockBilling = jest.fn();

jest.mock("@/lib/forcefield-web/tenants", () => ({
  resolveTenantByToken: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock("@/lib/forcefield-web/public-stats", () => ({
  getPublicForcefieldStats: (...a: unknown[]) => mockStats(...a),
}));
jest.mock("@/lib/forcefield-web/billing", () => ({
  getTenantBilling: (...a: unknown[]) => mockBilling(...a),
  // real logic, inlined so the test pulls no db dependency (isLicensed is pure
  // and unit-tested in billing.test.ts).
  isLicensed: (b: { status?: string }) => b?.status === "active" || b?.status === "trialing",
}));

import { GET } from "../route";

const TENANT = { id: "t-abc", name: "Before U Trade", siteLabel: "beforeutrade" };
const STATS = {
  rangeDays: 30, agentsDetected: 120, welcomed: 40, trapped: 5, probed: 60,
  payloads: 10, hostile: 75, sitesProtected: 1, attacks: [{ attack: "xss", count: 7 }],
};

const req = (token?: string) =>
  new NextRequest("http://x/api/forcefield/my-stats", {
    headers: token ? { "x-forcefield-token": token } : {},
  });

beforeEach(() => jest.clearAllMocks());

it("401 when no token is presented, and the stats helper is never called", async () => {
  mockResolve.mockResolvedValueOnce(null);
  const res = await GET(req());
  expect(res.status).toBe(401);
  expect(mockStats).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.ok).toBe(false);
});

it("401 on an unknown/disabled token (resolver returns null) - no cross-tenant leak", async () => {
  mockResolve.mockResolvedValueOnce(null);
  const res = await GET(req("ff_bogus"));
  expect(res.status).toBe(401);
  expect(mockStats).not.toHaveBeenCalled();
});

it("200 with stats scoped to the resolved tenant id", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockStats.mockResolvedValueOnce(STATS);
  mockBilling.mockResolvedValueOnce({ plan: "growth", status: "active", currentPeriodEnd: null });
  const res = await GET(req("ff_realtoken"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.tenant).toEqual(TENANT);
  expect(body.stats.agentsDetected).toBe(120);
  // the isolation guarantee: stats were requested for THIS tenant's id only
  expect(mockStats).toHaveBeenCalledWith(30, undefined, "t-abc");
});

it("resolves the tenant using the exact token from the header", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockStats.mockResolvedValueOnce(STATS);
  mockBilling.mockResolvedValueOnce(null);
  await GET(req("ff_realtoken"));
  expect(mockResolve).toHaveBeenCalledWith("ff_realtoken");
});

it("a LICENSED tenant -> enforcing:true (blocks for real)", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockStats.mockResolvedValueOnce(STATS);
  mockBilling.mockResolvedValueOnce({ plan: "growth", status: "active", currentPeriodEnd: null });
  const body = await (await GET(req("ff_realtoken"))).json();
  expect(body.enforcing).toBe(true);
  expect(body.plan).toBe("growth");
  expect(mockBilling).toHaveBeenCalledWith("t-abc");
});

it("an UNLICENSED tenant -> enforcing:false (watch-only, drives the upsell)", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockStats.mockResolvedValueOnce(STATS);
  mockBilling.mockResolvedValueOnce({ plan: "none", status: "none", currentPeriodEnd: null });
  const body = await (await GET(req("ff_realtoken"))).json();
  expect(body.enforcing).toBe(false);
  expect(body.plan).toBe("none");
});

it("no billing row -> enforcing:false, never overclaims a block", async () => {
  mockResolve.mockResolvedValueOnce(TENANT);
  mockStats.mockResolvedValueOnce(STATS);
  mockBilling.mockResolvedValueOnce(null);
  const body = await (await GET(req("ff_realtoken"))).json();
  expect(body.enforcing).toBe(false);
  expect(body.plan).toBe("none");
});
