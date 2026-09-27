/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/ai-code/history: gating + { runs, grade, drift }.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockListRuns = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/runs", () => ({
  listPipelineRuns: (...a: unknown[]) => mockListRuns(...a),
  toRunRecords: (runs: unknown[]) => runs, // identity: these are already record-shaped in the test
}));

import { GET } from "../route";

const req = () => new NextRequest("http://localhost/api/admin/ai-code/history?limit=10");

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
});

it("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
});

it("403 when not entitled", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req())).status).toBe(403);
});

it("returns runs + grade + drift, workspace-scoped", async () => {
  mockListRuns.mockResolvedValue([
    { model: "m", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", deepScanCritical: 0 },
    { model: "m", status: "needs_human", attempts: 2, finalOutcome: "block", deepScanCritical: 1 },
  ]);
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockListRuns).toHaveBeenCalledWith("w1", 10);
  expect(body.grade.total).toBe(2);
  expect(body.grade.blockRate).toBe(0.5);
  expect(Array.isArray(body.runs)).toBe(true);
  expect(Array.isArray(body.drift)).toBe(true);
});
