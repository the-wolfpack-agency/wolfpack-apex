/**
 * @jest-environment node
 *
 * Contract for /api/admin/tenants. registry + audit mocked - no DB. Proves the
 * connection string is never echoed and the attach is audited without the secret.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockList = jest.fn();
const mockSetConn = jest.fn();
const mockGet = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/registry", () => ({
  listTenants: (...a: unknown[]) => mockList(...a),
  setTenantConnection: (...a: unknown[]) => mockSetConn(...a),
  getTenant: (...a: unknown[]) => mockGet(...a),
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));

import { GET, POST } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = (body?: unknown) => new NextRequest("http://localhost/api/admin/tenants", { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const CONN = "postgres://user:pass@ep.neon.tech/db";

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockList.mockResolvedValue([{ tenant_id: "t-acme-ab12", org_name: "Acme", status: "pending_provision", has_db: false, admin_email: "a@acme.com", created_at: "2026-09-17" }]);
  mockGet.mockResolvedValue({ tenant_id: "t-acme-ab12" });
  mockSetConn.mockResolvedValue(true);
  mockAudit.mockResolvedValue(undefined);
});

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});
it("GET lists tenants, never a connection string", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tenants[0].tenant_id).toBe("t-acme-ab12");
  expect(JSON.stringify(body)).not.toContain("db_url");
});
it("POST attaches a DB and audits WITHOUT the connection string", async () => {
  const res = await POST(req({ tenantId: "t-acme-ab12", connectionString: CONN }));
  expect(res.status).toBe(200);
  expect(mockSetConn).toHaveBeenCalledWith("t-acme-ab12", CONN);
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockAudit.mock.calls[0][0])).not.toContain("pass"); // secret never audited
});
it("POST 400 without tenantId or connectionString", async () => {
  expect((await POST(req({ connectionString: CONN }))).status).toBe(400);
  expect((await POST(req({ tenantId: "t-acme-ab12" }))).status).toBe(400);
});
it("POST 404 for an unknown tenant", async () => {
  mockGet.mockResolvedValue(null);
  expect((await POST(req({ tenantId: "ghost", connectionString: CONN }))).status).toBe(404);
  expect(mockSetConn).not.toHaveBeenCalled();
});
