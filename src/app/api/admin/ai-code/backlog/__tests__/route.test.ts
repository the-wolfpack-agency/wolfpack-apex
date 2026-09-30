/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/backlog", () => ({
  ...jest.requireActual("@/lib/ai-code/backlog"),
  listCiFixOutcomes: (...a: unknown[]) => mockList(...a),
}));

import { GET } from "../route";
const req = (qs = "") => new NextRequest(`http://localhost/api/admin/ai-code/backlog?${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockList.mockResolvedValue([]);
});

it("401 unauth / 403 unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req())).status).toBe(403);
});

it("returns the workspace-scoped backlog, honoring days", async () => {
  mockList.mockResolvedValue([{ action: "escalate_human", class: "governance", reason: "x", repo: "o/r", ref: "f", createdAt: "2026-09-30T00:00:00Z" }]);
  const res = await GET(req("days=7"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockList).toHaveBeenCalledWith("w1", 7);
  expect(body.backlog.escalated).toBe(1);
  expect(body.backlog.byClass[0]).toEqual({ class: "governance", count: 1 });
});
