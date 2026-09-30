/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/ai-code/history: gating + { runs, grade, drift }.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockListRuns = jest.fn();
const mockListRepos = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
const mockProtections = jest.fn();
jest.mock("@/lib/ai-code/protections", () => ({ listProtections: (...a: unknown[]) => mockProtections(...a) }));
jest.mock("@/lib/ai-code/runs", () => ({
  listPipelineRuns: (...a: unknown[]) => mockListRuns(...a),
  listRunRepos: (...a: unknown[]) => mockListRepos(...a),
  toRunRecords: (runs: unknown[]) => runs, // identity: these are already record-shaped in the test
}));

import { GET } from "../route";

const req = () => new NextRequest("http://localhost/api/admin/ai-code/history?limit=10");

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockListRepos.mockResolvedValue(["(self)", "the-wolfpack-agency/wolfpack-ford"]);
  mockProtections.mockResolvedValue({ totalCaught: 4, byClass: [{ klass: "logged_credential", label: "Secret written to a log", count: 4 }], changesBlocked: 1, sentForReview: 0, criticalsCaught: 2, windowDays: 30 });
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
  expect(mockListRuns).toHaveBeenCalledWith("w1", 10, undefined);
  expect(body.repos).toEqual(["(self)", "the-wolfpack-agency/wolfpack-ford"]);
  expect(body.grade.total).toBe(2);
  expect(body.grade.blockRate).toBe(0.5);
  expect(Array.isArray(body.runs)).toBe(true);
  expect(Array.isArray(body.drift)).toBe(true);
  expect(body.protected.totalCaught).toBe(4);
  expect(body.protected.byClass[0].label).toMatch(/secret/i);
});

it("scopes runs to one site when ?repo= is set, but the site list stays complete", async () => {
  mockListRuns.mockResolvedValue([]);
  const r = new NextRequest("http://localhost/api/admin/ai-code/history?limit=10&repo=the-wolfpack-agency/wolfpack-ford");
  const res = await GET(r);
  expect(res.status).toBe(200);
  const body = await res.json();
  // the runs read is filtered...
  expect(mockListRuns).toHaveBeenCalledWith("w1", 10, "the-wolfpack-agency/wolfpack-ford");
  expect(body.repo).toBe("the-wolfpack-agency/wolfpack-ford");
  // ...but the selector's site list is the unfiltered distinct set
  expect(body.repos).toEqual(["(self)", "the-wolfpack-agency/wolfpack-ford"]);
});
