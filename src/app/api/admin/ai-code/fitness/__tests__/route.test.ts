/** @jest-environment node */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockGate = jest.fn();
const mockRuns = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
// identity toRunRecords so we can feed PipelineRunRecord-shaped rows straight in.
jest.mock("@/lib/ai-code/runs", () => ({
  listPipelineRuns: (...a: unknown[]) => mockRuns(...a),
  toRunRecords: (r: unknown) => r,
}));

import { GET } from "../route";
const get = () => new NextRequest("http://localhost/api/admin/ai-code/fitness");

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockRuns.mockResolvedValue([]);
});

it("401 when capability fails, 403 when entitlement gate blocks", async () => {
  mockCap.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  mockCap.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(get())).status).toBe(403);
});

it("200 returns { overall, models, drift } even with no runs", async () => {
  const res = await GET(get());
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j).toHaveProperty("overall");
  expect(Array.isArray(j.models)).toBe(true);
  expect(Array.isArray(j.drift)).toBe(true);
  expect(j.models).toHaveLength(0);
  expect(mockRuns).toHaveBeenCalledWith("w1", 200);
});

it("200 with runs produces a per-model row (gradeRuns + the scorers run server-side)", async () => {
  mockRuns.mockResolvedValue([
    { model: "gpt-4o", status: "ready_for_pr", attempts: 0, finalOutcome: "allow", costUsd: 0.001 },
    { model: "gpt-4o", status: "needs_human", attempts: 1, finalOutcome: "block", brokenLocalImports: 1, costUsd: 0.001 },
  ]);
  const j = await (await GET(get())).json();
  expect(j.models.length).toBeGreaterThanOrEqual(1);
  const row = j.models.find((m: { model: string }) => m.model === "gpt-4o");
  expect(row).toMatchObject({ model: "gpt-4o", n: 2 });
  expect(typeof row.observedTier).toBe("string");
  expect(typeof row.topFailure).toBe("string");
});
