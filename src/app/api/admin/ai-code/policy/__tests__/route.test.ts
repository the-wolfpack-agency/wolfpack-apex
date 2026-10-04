/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockLoad = jest.fn();
const mockSave = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAuditNonFatal: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "t", requestId: "r" }) }));
jest.mock("@/lib/ai-code/policy-store", () => ({
  loadCodeGatePolicy: (...a: unknown[]) => mockLoad(...a),
  saveCodeGatePolicy: (...a: unknown[]) => mockSave(...a),
}));

import { GET, PUT } from "../route";
const get = () => new NextRequest("http://localhost/api/admin/ai-code/policy");
const put = (body: unknown) => new NextRequest("http://localhost/api/admin/ai-code/policy", { method: "PUT", body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockLoad.mockResolvedValue({ protectedPaths: ["src/lib/crypto/"], denyRules: [] });
  mockSave.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue({ ok: true });
});

it("401/403 on both verbs when unauth/unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  expect((await PUT(put({}))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(get())).status).toBe(403);
});

it("GET returns the workspace policy", async () => {
  const res = await GET(get());
  expect(res.status).toBe(200);
  expect((await res.json()).policy.protectedPaths).toEqual(["src/lib/crypto/"]);
  expect(mockLoad).toHaveBeenCalledWith("w1");
});

it("PUT sanitizes, saves, audits, tracks; returns policy + warnings", async () => {
  const res = await PUT(put({ protectedPaths: ["src/ok/", "(["], denyRules: [{ title: "no fetch", pattern: "fetch\\(", severity: "high" }] }));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.policy.protectedPaths).toEqual(["src/ok/"]); // invalid regex dropped
  expect(json.warnings.length).toBeGreaterThan(0);
  expect(mockSave).toHaveBeenCalledWith("w1", expect.objectContaining({ protectedPaths: ["src/ok/"] }), "u1");
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.policy.updated", resourceId: "w1" }));
  expect(mockTrack).toHaveBeenCalledWith("ai_code.policy_set", "u1", "admin", expect.objectContaining({ workspace_id: "w1" }));
});

it("PUT invalid JSON -> 400 (no save)", async () => {
  const bad = new NextRequest("http://localhost/api/admin/ai-code/policy", { method: "PUT", body: "{not json" });
  expect((await PUT(bad)).status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

it("PUT returns 500 when the write fails (never a false success)", async () => {
  mockSave.mockRejectedValue(new Error("db down"));
  const res = await PUT(put({ denyRules: [{ title: "x", pattern: "x", severity: "low" }] }));
  expect(res.status).toBe(500);
  expect(mockAudit).not.toHaveBeenCalled(); // did not claim an audited change that didn't happen
});
