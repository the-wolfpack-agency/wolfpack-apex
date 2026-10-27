/**
 * Contract: the Forcefield Edge ingest path. Edge serves many tenants with ONE
 * service token and names the tenant per event in x-forcefield-edge-tenant.
 *
 *  - service token + an ACTIVE tenant id -> 200, the event is attributed to that
 *    tenant and pinned to its site label (the body cannot pick another site), on
 *    the tenant's own rate bucket, exactly like the tenant's own token;
 *  - a tenant header with any other token -> ignored (no cross-tenant writes);
 *  - the service token for an unknown / disabled tenant -> 401;
 *  - an unset or short service token disables the path.
 */
export {};

const mockRecordSiteEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/site-analytics", () => ({
  ...jest.requireActual("@/lib/site-analytics"),
  recordSiteEvent: (...a: unknown[]) => mockRecordSiteEvent(...a),
}));
const mockResolveTenant = jest.fn().mockResolvedValue(null);
jest.mock("@/lib/forcefield-web/tenants", () => ({
  resolveTenantByToken: (...a: unknown[]) => mockResolveTenant(...a),
}));
const mockById = jest.fn();
jest.mock("@/lib/forcefield-web/edge-sites", () => ({
  resolveActiveTenantById: (...a: unknown[]) => mockById(...a),
}));
const mockRateLimit = jest.fn().mockResolvedValue({ ok: true });
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

import { POST } from "@/app/api/site-analytics/ingest/route";
import { _resetRateWindow } from "@/lib/forcefield/rate-window";

const SERVICE = "edge-service-token-0123456789abcdef0123456789";
const TENANT_ID = "6f1c2a1e-3b7d-4c55-9a10-2b3c4d5e6f70";
const ORIGINAL = { s: process.env.FORCEFIELD_EDGE_SERVICE_TOKEN, t1: process.env.SITE_ANALYTICS_INGEST_TOKEN, db: process.env.DATABASE_URL };

function mkReq(body: unknown, token: string, tenant?: string): any {
  const headers = new Headers({ "content-type": "application/json", "x-ingest-token": token });
  if (tenant) headers.set("x-forcefield-edge-tenant", tenant);
  return new Request("http://test/api/site-analytics/ingest", { method: "POST", headers, body: JSON.stringify(body) }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateWindow();
  process.env.FORCEFIELD_EDGE_SERVICE_TOKEN = SERVICE;
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "shared-secret";
  process.env.DATABASE_URL = "postgres://registry";
  mockRateLimit.mockResolvedValue({ ok: true });
  mockById.mockImplementation(async (id: string) => (id === TENANT_ID ? { id: TENANT_ID, siteLabel: "client.example" } : null));
});
afterAll(() => {
  for (const [k, v] of [["FORCEFIELD_EDGE_SERVICE_TOKEN", ORIGINAL.s], ["SITE_ANALYTICS_INGEST_TOKEN", ORIGINAL.t1], ["DATABASE_URL", ORIGINAL.db]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

it("200: service token + active tenant -> attributed, site pinned, tenant bucket", async () => {
  const res = await POST(mkReq({ type: "site.agent_payload_attack", path: "/wp-admin/admin-ajax.php", props: { site: "victim.example", attack: "php2shell" } }, SERVICE, TENANT_ID));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const call = mockRecordSiteEvent.mock.calls[0][0];
  expect(call.tenantId).toBe(TENANT_ID);
  expect(call.props.site).toBe("client.example"); // pinned, the body's site ignored
  expect(call.props.attack).toBe("php2shell");
  expect(mockRateLimit.mock.calls[0][0]).toBe(`site-analytics:ingest:tenant:${TENANT_ID}`);
});

it("401: service token for an unknown or disabled tenant", async () => {
  const res = await POST(mkReq({ type: "site.page_viewed" }, SERVICE, "00000000-0000-4000-8000-000000000000"));
  expect(res.status).toBe(401);
  expect(mockRecordSiteEvent).not.toHaveBeenCalled();
});

it("401: the service token alone (no tenant header) is not a shared ingest token", async () => {
  const res = await POST(mkReq({ type: "site.page_viewed" }, SERVICE));
  expect(res.status).toBe(401);
});

it("a tenant header with the SHARED token is ignored: no lookup, the shared path's own site stays", async () => {
  const res = await POST(mkReq({ type: "site.page_viewed", props: { site: "ogiam.com" } }, "shared-secret", TENANT_ID));
  expect(res.status).toBe(200);
  expect(mockById).not.toHaveBeenCalled();
  expect(mockRecordSiteEvent.mock.calls[0][0]).toMatchObject({ tenantId: null, props: { site: "ogiam.com" } });
});

it("a short / unset service token disables the Edge path", async () => {
  process.env.FORCEFIELD_EDGE_SERVICE_TOKEN = "short";
  const res = await POST(mkReq({ type: "site.page_viewed" }, "short", TENANT_ID));
  expect(res.status).toBe(401);
  expect(mockById).not.toHaveBeenCalled();
});
