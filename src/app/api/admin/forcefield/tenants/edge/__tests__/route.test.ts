/**
 * @jest-environment node
 *
 * Contract for POST /api/admin/forcefield/tenants/edge - putting a tenant on
 * Forcefield Edge. Auth (401/403, nothing touched); 400 on a bad action, origin
 * or hostname; set_origin returns the secret ONCE and the audit never carries
 * it; add_hostname maps the claim conflicts (409) and the provisioning result
 * (200 with the DNS record, 503 when the Edge project is not configured, the
 * platform's typed errors); check_hostname only for a hostname the tenant holds.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockRecordAudit = jest.fn();
const mockTrack = jest.fn();
const mockValidate = jest.fn();
const mockSetOrigin = jest.fn();
const mockRotate = jest.fn();
const mockAddHostname = jest.fn();
const mockList = jest.fn();
const mockState = jest.fn();
const mockProvision = jest.fn();
const mockCheck = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/forcefield-web/edge-sites", () => ({
  ...jest.requireActual("@/lib/forcefield-web/edge-sites"),
  validateEdgeOrigin: (...a: unknown[]) => mockValidate(...a),
  setEdgeOrigin: (...a: unknown[]) => mockSetOrigin(...a),
  rotateEdgeSecret: (...a: unknown[]) => mockRotate(...a),
  addEdgeHostname: (...a: unknown[]) => mockAddHostname(...a),
  listEdgeHostnames: (...a: unknown[]) => mockList(...a),
  getEdgeTenantState: (...a: unknown[]) => mockState(...a),
}));
jest.mock("@/lib/forcefield-web/edge-provision", () => ({
  provisionEdgeHostname: (...a: unknown[]) => mockProvision(...a),
  checkEdgeHostname: (...a: unknown[]) => mockCheck(...a),
}));

import { POST } from "../route";

const OK = { ok: true, user: { id: "op-1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const post = (body: unknown) => POST(new NextRequest("http://x/api/admin/forcefield/tenants/edge", { method: "POST", body: JSON.stringify(body) }));
const SECRET = "ffe_" + "z".repeat(43);
const LIVE = {
  ok: true,
  hostname: "edge-test.ogiam.com",
  attached: true,
  live: false,
  configuredBy: null,
  records: [{ type: "CNAME", name: "edge-test", value: "abc.vercel-dns-017.com", purpose: "route" }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK);
  mockRecordAudit.mockResolvedValue(undefined);
});

it("401/403 when denied; nothing touched", async () => {
  mockRequireCapability.mockResolvedValueOnce(deny(401));
  expect((await post({ id: "t1", action: "set_origin", origin: "https://o.example" })).status).toBe(401);
  mockRequireCapability.mockResolvedValueOnce(deny(403));
  expect((await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" })).status).toBe(403);
  expect(mockSetOrigin).not.toHaveBeenCalled();
  expect(mockAddHostname).not.toHaveBeenCalled();
});

it("400 on an unknown action or a missing id", async () => {
  expect((await post({ id: "t1", action: "delete_everything" })).status).toBe(400);
  expect((await post({ action: "status" })).status).toBe(400);
});

it("status: 200 with state + hostnames, never a secret; 404 for an unknown tenant", async () => {
  mockState.mockResolvedValueOnce({ originUrl: "https://o.example", hasSecret: true, secretRotatedAt: "2026-10-26" });
  mockList.mockResolvedValueOnce([{ hostname: "a.example.com", verified: false, dnsRecords: [], lastCheckedAt: null }]);
  const res = await post({ id: "t1", action: "status" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, originUrl: "https://o.example", hasSecret: true, hostnames: [{ hostname: "a.example.com" }] });
  expect(body.originSecret).toBeUndefined();
  mockState.mockResolvedValueOnce(null);
  expect((await post({ id: "nope", action: "status" })).status).toBe(404);
});

it("set_origin: 400 on an invalid or private origin", async () => {
  mockValidate.mockResolvedValueOnce({ ok: false, reason: "origin_not_public" });
  const res = await post({ id: "t1", action: "set_origin", origin: "https://10.0.0.5" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ ok: false, error: "origin_not_public" });
  expect(mockSetOrigin).not.toHaveBeenCalled();
});

it("set_origin: 200, secret returned ONCE with the origin contract; audit and analytics never carry it", async () => {
  mockValidate.mockResolvedValueOnce({ ok: true, origin: "https://origin.client.example" });
  mockSetOrigin.mockResolvedValueOnce({ origin: "https://origin.client.example", secret: SECRET });
  const res = await post({ id: "t1", action: "set_origin", origin: "https://origin.client.example" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.originSecret).toBe(SECRET);
  expect(body.originContract.header).toBe("x-forcefield-edge");
  expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.edge_origin_set", resourceId: "t1" }));
  expect(JSON.stringify(mockRecordAudit.mock.calls)).not.toContain(SECRET);
  expect(JSON.stringify(mockTrack.mock.calls)).not.toContain(SECRET);

  // A second set (secret already issued) does not re-reveal anything.
  mockValidate.mockResolvedValueOnce({ ok: true, origin: "https://origin2.client.example" });
  mockSetOrigin.mockResolvedValueOnce({ origin: "https://origin2.client.example", secret: null });
  const again = await (await post({ id: "t1", action: "set_origin", origin: "https://origin2.client.example" })).json();
  expect(again.originSecret).toBeUndefined();
});

it("set_origin: 404 for an unknown or disabled tenant", async () => {
  mockValidate.mockResolvedValueOnce({ ok: true, origin: "https://o.example" });
  mockSetOrigin.mockResolvedValueOnce(null);
  expect((await post({ id: "gone", action: "set_origin", origin: "https://o.example" })).status).toBe(404);
});

it("rotate_secret: 200 with the new secret once, audited without it; 404 when no origin", async () => {
  mockRotate.mockResolvedValueOnce({ secret: SECRET });
  const res = await post({ id: "t1", action: "rotate_secret" });
  expect(res.status).toBe(200);
  expect((await res.json()).originSecret).toBe(SECRET);
  expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.edge_secret_rotated" }));
  expect(JSON.stringify(mockRecordAudit.mock.calls)).not.toContain(SECRET);
  mockRotate.mockResolvedValueOnce(null);
  expect((await post({ id: "t1", action: "rotate_secret" })).status).toBe(404);
});

it("add_hostname: 400 on an invalid hostname, nothing claimed", async () => {
  expect((await post({ id: "t1", action: "add_hostname", hostname: "localhost" })).status).toBe(400);
  expect((await post({ id: "t1", action: "add_hostname", hostname: "10.0.0.1" })).status).toBe(400);
  expect(mockAddHostname).not.toHaveBeenCalled();
});

it("add_hostname: 409 when another tenant holds it or there is no origin; 404 unknown tenant", async () => {
  mockAddHostname.mockResolvedValueOnce({ ok: false, error: "hostname_in_use" });
  expect((await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" })).status).toBe(409);
  mockAddHostname.mockResolvedValueOnce({ ok: false, error: "no_origin" });
  expect((await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" })).status).toBe(409);
  mockAddHostname.mockResolvedValueOnce({ ok: false, error: "not_found" });
  expect((await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" })).status).toBe(404);
  expect(mockProvision).not.toHaveBeenCalled();
});

it("add_hostname: 200 with the DNS record the owner must create; audited once on first claim", async () => {
  mockAddHostname.mockResolvedValueOnce({ ok: true, hostname: "edge-test.ogiam.com", created: true });
  mockProvision.mockResolvedValueOnce(LIVE);
  const res = await post({ id: "t1", action: "add_hostname", hostname: "Edge-Test.ogiam.com" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(LIVE);
  expect(mockAddHostname).toHaveBeenCalledWith("t1", "edge-test.ogiam.com");
  expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.edge_hostname_added", afterState: { hostname: "edge-test.ogiam.com" } }));
  expect(mockTrack).toHaveBeenCalledWith("forcefield.edge_hostname_added", "op-1", "admin", expect.objectContaining({ hostname: "edge-test.ogiam.com", provisioned: true }));
});

it("add_hostname: 503 with a clear reason when the Edge project is not configured", async () => {
  mockAddHostname.mockResolvedValueOnce({ ok: true, hostname: "a.example.com", created: true });
  mockProvision.mockResolvedValueOnce({ ok: false, error: "not_configured", status: 0 });
  const res = await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe("edge_project_not_configured");
});

it("add_hostname: a platform 403 / 429 surfaces as a typed error, not a throw", async () => {
  mockAddHostname.mockResolvedValue({ ok: true, hostname: "a.example.com", created: false });
  mockProvision.mockResolvedValueOnce({ ok: false, error: "unauthorized", status: 403 });
  let res = await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" });
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ ok: false, error: "vercel_unauthorized", platformStatus: 403 });
  mockProvision.mockResolvedValueOnce({ ok: false, error: "rate_limited", status: 429 });
  res = await post({ id: "t1", action: "add_hostname", hostname: "a.example.com" });
  expect(res.status).toBe(429);
  mockAddHostname.mockReset();
});

it("check_hostname: 404 for a hostname the tenant does not hold; 200 with live state otherwise", async () => {
  mockList.mockResolvedValue([{ hostname: "edge-test.ogiam.com", verified: false, dnsRecords: [], lastCheckedAt: null }]);
  expect((await post({ id: "t1", action: "check_hostname", hostname: "other.example.com" })).status).toBe(404);
  expect(mockCheck).not.toHaveBeenCalled();
  mockCheck.mockResolvedValueOnce({ ...LIVE, live: true, configuredBy: "CNAME" });
  const res = await post({ id: "t1", action: "check_hostname", hostname: "edge-test.ogiam.com" });
  expect(res.status).toBe(200);
  expect((await res.json()).live).toBe(true);
});
