/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/tenants. The registry behavior is proven in
 * the tenants unit tests; this asserts the ROUTE: auth (401/403), create returns
 * 201 with the token + quick-start exactly once, invalid input is 400 (not 500),
 * and GET lists without leaking a token. The lib is mocked so the contract does
 * not need a database.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockCreate = jest.fn();
const mockList = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/forcefield-web/tenants", () => ({
  createForcefieldTenant: (...a: unknown[]) => mockCreate(...a),
  listForcefieldTenants: (...a: unknown[]) => mockList(...a),
}));
const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { GET, POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const TENANT = { id: "t1", name: "Before U Trade", siteLabel: "beforeutrade", status: "active", createdAt: "2026-10-06T00:00:00Z" };

const post = (body: unknown) =>
  new NextRequest("http://x/api/admin/forcefield/tenants", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockRecordAudit.mockResolvedValue(undefined); });

describe("GET", () => {
  it("401/403 when the capability check denies", async () => {
    mockRequireCapability.mockResolvedValueOnce(deny(401));
    expect((await GET(new NextRequest("http://x"))).status).toBe(401);
    mockRequireCapability.mockResolvedValueOnce(deny(403));
    expect((await GET(new NextRequest("http://x"))).status).toBe(403);
  });

  it("lists tenants and the response carries no token", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockList.mockResolvedValueOnce([TENANT]);
    const res = await GET(new NextRequest("http://x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });
});

describe("POST", () => {
  it("403 when denied", async () => {
    mockRequireCapability.mockResolvedValueOnce(deny(403));
    expect((await POST(post({ name: "x", siteLabel: "y" }))).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("201 with the tenant, the token, and the quick-start on success", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockCreate.mockResolvedValueOnce({ tenant: TENANT, token: "ff_realtoken" });
    const res = await POST(post({ name: "Before U Trade", siteLabel: "beforeutrade" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe("ff_realtoken");
    expect(body.tenant.siteLabel).toBe("beforeutrade");
    // the quick-start is built from the real token + site
    expect(body.quickstart.cloudflareEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_realtoken");
    expect(body.quickstart.cloudflareEnv.FORCEFIELD_SITE).toBe("beforeutrade");
    expect(body.quickstart.cloudflareEnv.FORCEFIELD_ENFORCE).toBe("off");
    // the issuance is audited, and the audit NEVER carries the token
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(audit.action).toBe("forcefield.tenant_provisioned");
    expect(JSON.stringify(audit)).not.toContain("ff_realtoken");
  });

  it("400 (not 500) on invalid input", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockCreate.mockResolvedValueOnce(null); // lib rejects empty name/site
    const res = await POST(post({ name: "", siteLabel: "" }));
    expect(res.status).toBe(400);
  });
});
