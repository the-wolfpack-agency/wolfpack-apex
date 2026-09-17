/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/canaries. The store behavior is proven in
 * the canary-store unit + db tests; this asserts the ROUTE: auth (401/403),
 * body validation returning 400 (not 500), the DISPLAY-safe shape on GET, the
 * create + retire delegation, and that both mutations are audited. The store is
 * mocked so the contract does not depend on a database.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockDeactivate = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/forcefield/canary-store", () => ({
  listCanariesForDisplay: (...a: unknown[]) => mockList(...a),
  createCanary: (...a: unknown[]) => mockCreate(...a),
  deactivateCanary: (...a: unknown[]) => mockDeactivate(...a),
  // The real predicate - the route validates kind through it.
  isCanaryKind: (v: unknown) => v === "token" || v === "route" || v === "row" || v === "tool",
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { GET, POST, DELETE } from "../route";

const OK_USER = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });

const DISPLAY = { id: "c1", kind: "token", seededIn: "customers table", valueHint: "****9f3a", active: true, createdAt: "2026-09-17T00:00:00.000Z" };

function req(method: string, body?: unknown, qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/admin/forcefield/canaries${qs}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK_USER);
  mockList.mockResolvedValue([DISPLAY]);
  mockCreate.mockResolvedValue(DISPLAY);
  mockDeactivate.mockResolvedValue(true);
  mockRecordAudit.mockResolvedValue({ ok: true });
});

describe("GET /api/admin/forcefield/canaries", () => {
  it("401 without a session", async () => {
    mockRequireCapability.mockResolvedValue(deny(401));
    expect((await GET(req("GET"))).status).toBe(401);
  });
  it("403 without settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValue(deny(403));
    expect((await GET(req("GET"))).status).toBe(403);
  });
  it("200 returns the workspace's canaries, DISPLAY-safe (masked hint, no value)", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockList).toHaveBeenCalledWith("w1");
    expect(body.canaries[0].valueHint).toBe("****9f3a");
    expect(JSON.stringify(body)).not.toContain('"value":'); // only valueHint is exposed, never a raw value
  });
});

describe("POST /api/admin/forcefield/canaries", () => {
  it("400 on an unknown kind (not a 500)", async () => {
    const res = await POST(req("POST", { kind: "nope", value: "x", seededIn: "y" }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
  it("400 when value is missing", async () => {
    expect((await POST(req("POST", { kind: "token", seededIn: "y" }))).status).toBe(400);
  });
  it("400 when seededIn is missing", async () => {
    expect((await POST(req("POST", { kind: "token", value: "x" }))).status).toBe(400);
  });
  it("201 seeds the decoy and audits it (value never in the audit state)", async () => {
    const res = await POST(req("POST", { kind: "token", value: "sk-decoy-9f3a", seededIn: "customers table" }));
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", kind: "token", value: "sk-decoy-9f3a", createdBy: "u1" }));
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(JSON.stringify(audit.afterState)).not.toContain("sk-decoy-9f3a"); // only the masked hint is audited
    expect(audit.afterState.value_hint).toBe("****9f3a");
  });
  it("503 when the store is unavailable (no DB)", async () => {
    mockCreate.mockResolvedValue(null);
    expect((await POST(req("POST", { kind: "token", value: "x", seededIn: "y" }))).status).toBe(503);
  });
});

describe("DELETE /api/admin/forcefield/canaries", () => {
  it("400 without an id", async () => {
    expect((await DELETE(req("DELETE"))).status).toBe(400);
  });
  it("404 when the decoy does not exist", async () => {
    mockDeactivate.mockResolvedValue(false);
    expect((await DELETE(req("DELETE", undefined, "?id=missing"))).status).toBe(404);
  });
  it("200 retires the decoy, scoped to the workspace, and audits it", async () => {
    const res = await DELETE(req("DELETE", undefined, "?id=c1"));
    expect(res.status).toBe(200);
    expect(mockDeactivate).toHaveBeenCalledWith("w1", "c1");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith("forcefield.canary_retired", "u1", "admin", expect.objectContaining({ workspace_id: "w1" }));
  });
});
