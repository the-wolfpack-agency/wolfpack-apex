/**
 * @jest-environment node
 *
 * Contract for /api/admin/entitlements. lib + audit mocked - no DB.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockList = jest.fn();
const mockSet = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/entitlements", () => ({
  listEntitlements: (...a: unknown[]) => mockList(...a),
  setEntitlement: (...a: unknown[]) => mockSet(...a),
  isKnownFeature: (k: string) => k === "secure_agent" || k === "forcefield",
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));

import { GET, POST } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = (body?: unknown) => new NextRequest("http://localhost/api/admin/entitlements", { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockList.mockResolvedValue([{ key: "forcefield", label: "Forcefield", description: "d", envDefault: true, override: null, effective: true }]);
  mockSet.mockResolvedValue(true);
  mockAudit.mockResolvedValue(undefined);
});

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
  mockCap.mockResolvedValue(deny(403));
  expect((await POST(req({ feature: "forcefield", enabled: false }))).status).toBe(403);
});
it("GET lists the workspace entitlements", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith("w1");
  expect((await res.json()).entitlements[0].key).toBe("forcefield");
});
it("POST sets an override and audits it", async () => {
  const res = await POST(req({ feature: "forcefield", enabled: false }));
  expect(res.status).toBe(200);
  expect(mockSet).toHaveBeenCalledWith({ workspaceId: "w1", userId: "u1", role: "admin" }, "forcefield", false);
  expect(mockAudit).toHaveBeenCalledTimes(1);
});
it("POST 400 on unknown feature (no write)", async () => {
  expect((await POST(req({ feature: "nope", enabled: true }))).status).toBe(400);
  expect(mockSet).not.toHaveBeenCalled();
});
it("POST 400 when enabled is not true/false/null", async () => {
  expect((await POST(req({ feature: "forcefield", enabled: "yes" }))).status).toBe(400);
});
it("POST accepts null (clear)", async () => {
  expect((await POST(req({ feature: "forcefield", enabled: null }))).status).toBe(200);
  expect(mockSet).toHaveBeenCalledWith(expect.anything(), "forcefield", null);
});
