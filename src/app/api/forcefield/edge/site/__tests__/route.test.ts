/**
 * @jest-environment node
 *
 * Contract for GET /api/forcefield/edge/site - the Edge app's hostname lookup.
 * 503 when the service token is not configured (never open), 401 on a wrong
 * token, 400 on an invalid host, 404 for an unknown hostname, 200 with the site
 * record otherwise. Every answer is no-store (the record carries the secret).
 */
import { NextRequest } from "next/server";

const mockResolve = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/edge-sites", () => ({
  ...jest.requireActual("@/lib/forcefield-web/edge-sites"),
  resolveEdgeSiteByHost: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { GET } from "../route";

const TOKEN = "edge-service-token-0123456789abcdef0123456789";
const SITE = {
  tenantId: "6f1c2a1e-3b7d-4c55-9a10-2b3c4d5e6f70",
  siteLabel: "client.example",
  originUrl: "https://origin.client.example",
  originSecret: "ffe_" + "s".repeat(43),
  enforce: true,
};
const ORIGINAL = process.env.FORCEFIELD_EDGE_SERVICE_TOKEN;
const get = (host: string | null, token?: string) =>
  GET(new NextRequest(`http://x/api/forcefield/edge/site${host === null ? "" : `?host=${encodeURIComponent(host)}`}`, { headers: token ? { "x-edge-service-token": token } : {} }));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FORCEFIELD_EDGE_SERVICE_TOKEN = TOKEN;
  mockResolve.mockImplementation(async (h: string) => (h === "www.client.example" ? SITE : null));
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.FORCEFIELD_EDGE_SERVICE_TOKEN;
  else process.env.FORCEFIELD_EDGE_SERVICE_TOKEN = ORIGINAL;
});

it("503 when the service token is unset or too short (feature off)", async () => {
  delete process.env.FORCEFIELD_EDGE_SERVICE_TOKEN;
  expect((await get("www.client.example", TOKEN)).status).toBe(503);
  process.env.FORCEFIELD_EDGE_SERVICE_TOKEN = "short";
  expect((await get("www.client.example", "short")).status).toBe(503);
  expect(mockResolve).not.toHaveBeenCalled();
});

it("401 on a missing or wrong token, no lookup", async () => {
  expect((await get("www.client.example")).status).toBe(401);
  expect((await get("www.client.example", TOKEN.replace(/.$/, "x"))).status).toBe(401);
  expect(mockResolve).not.toHaveBeenCalled();
});

it("400 on a missing or invalid host", async () => {
  expect((await get(null, TOKEN)).status).toBe(400);
  expect((await get("127.0.0.1", TOKEN)).status).toBe(400);
  expect((await get("not a host", TOKEN)).status).toBe(400);
});

it("404 for an unknown hostname, recorded as found:false", async () => {
  const res = await get("nobody.example", TOKEN);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ ok: false, error: "unknown_host" });
  expect(mockTrack).toHaveBeenCalledWith("forcefield.edge_site_resolved", "system", "forcefield", { host: "nobody.example", found: false });
});

it("200 with the site record, no-store, host normalized (case, port, trailing dot)", async () => {
  const res = await get("WWW.Client.Example.:443", TOKEN);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ ok: true, site: SITE });
  expect(mockResolve).toHaveBeenCalledWith("www.client.example");
  // The analytics event never carries the secret.
  expect(JSON.stringify(mockTrack.mock.calls)).not.toContain(SITE.originSecret);
});
