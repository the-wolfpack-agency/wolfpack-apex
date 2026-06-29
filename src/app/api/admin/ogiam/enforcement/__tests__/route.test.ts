/**
 * Contract tests for /api/admin/ogiam/enforcement (GET/PUT/DELETE). Locks the
 * auth gate (401/403), PUT validation (400 on missing capability / invalid mode),
 * the upsert + ogiam.enforcement_posture_changed emit (with prev_mode), and the
 * DELETE revert-to-default path. The store + analytics are mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockList = jest.fn();
const mockSet = jest.fn();
const mockDelete = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ogiam/enforcement-policy", () => ({
  listEnforcementPolicy: (...a: unknown[]) => mockList(...a),
  setEnforcementPolicy: (...a: unknown[]) => mockSet(...a),
  deleteEnforcementPolicy: (...a: unknown[]) => mockDelete(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET, PUT, DELETE } from "../route";

function req(method: string, body?: unknown, qs = ""): NextRequest {
  return new NextRequest(`https://x.test/api/admin/ogiam/enforcement${qs}`, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (status: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status }) });

beforeEach(() => {
  jest.resetAllMocks();
  mockList.mockResolvedValue([]);
  mockSet.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockRecordAudit.mockResolvedValue({ ok: true });
});

test("GET 401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req("GET"))).status).toBe(401);
});

test("GET returns the workspace posture list", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockList.mockResolvedValue([{ capability: "mail.send", mode: "enforce", updatedAt: "t", updatedBy: "u" }]);
  const res = await GET(req("GET"));
  expect(res.status).toBe(200);
  expect((await res.json()).policy).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith("w-1");
});

test("PUT 403 when lacking capability", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await PUT(req("PUT", { capability: "x", mode: "enforce" }))).status).toBe(403);
});

test("PUT 400 on missing capability or invalid mode", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await PUT(req("PUT", { mode: "enforce" }))).status).toBe(400);
  expect((await PUT(req("PUT", { capability: "x", mode: "block" }))).status).toBe(400);
  expect(mockSet).not.toHaveBeenCalled();
});

test("PUT upserts the posture and emits the change with prev_mode", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockList.mockResolvedValue([{ capability: "finance.write", mode: "monitor", updatedAt: "t", updatedBy: "u" }]);
  const res = await PUT(req("PUT", { capability: "finance.write", mode: "enforce" }));
  expect(res.status).toBe(200);
  expect(mockSet).toHaveBeenCalledWith({ workspaceId: "w-1", capability: "finance.write", mode: "enforce", updatedBy: "u-1" });
  // Security-relevant posture change is hash-chain audited (before+after state).
  expect(mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "ogiam.enforcement_posture.updated",
      resourceType: "ogiam_enforcement_policy",
      resourceId: "w-1:finance.write",
      beforeState: { mode: "monitor" },
      afterState: { mode: "enforce" },
    }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ogiam.enforcement_posture_changed",
    "u-1",
    "cto",
    expect.objectContaining({ capability: "finance.write", mode: "enforce", prev_mode: "monitor" }),
  );
});

test("PUT records prev_mode 'default' when no prior override exists", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockList.mockResolvedValue([]);
  await PUT(req("PUT", { capability: "mail.send", mode: "enforce" }));
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ogiam.enforcement_posture_changed",
    "u-1",
    "cto",
    expect.objectContaining({ prev_mode: "default" }),
  );
});

test("DELETE reverts a capability to default (querystring form)", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await DELETE(req("DELETE", undefined, "?capability=mail.send"));
  expect(res.status).toBe(200);
  expect(mockDelete).toHaveBeenCalledWith("w-1", "mail.send");
  expect((await res.json()).mode).toBe("default");
});

test("DELETE 400 when no capability supplied", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await DELETE(req("DELETE"))).status).toBe(400);
  expect(mockDelete).not.toHaveBeenCalled();
});
