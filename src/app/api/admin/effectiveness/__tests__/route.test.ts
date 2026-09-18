/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/effectiveness. computeEffectiveness mocked - no DB.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockCompute = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/effectiveness/rollup", () => ({
  computeEffectiveness: (...a: unknown[]) => mockCompute(...a),
  liveEffectivenessDeps: () => ({}),
}));

import { GET } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = () => new NextRequest("http://localhost/api/admin/effectiveness");

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockCompute.mockResolvedValue({ sampleCapped: false, secureAgent: { changesGoverned: 2, blocked: 1, sentToHuman: 0, allowed: 1, risksCaught: 3 }, forcefield: { decoysActive: 4, trips: 1, agentsContained: 1 }, governance: { actionsGoverned: 9, denied: 2, escalated: 1, transformed: 0, allowed: 6, wouldBlock: 3, agentsActive: 2 }, cost: { monthToDateUsd: 12.5, measured: true }, enforcement: { capabilityDenied: 5, connectorScopeDenied: 2, ceilingHits: 3, conductDenied: 1, total: 11 } });
});

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
  mockCap.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});
it("200 returns the workspace-scoped report", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(mockCompute).toHaveBeenCalledWith("w1", expect.anything());
  const body = await res.json();
  expect(body.report.secureAgent.blocked).toBe(1);
  expect(body.report.forcefield.decoysActive).toBe(4);
  expect(body.report.governance.actionsGoverned).toBe(9);
  expect(body.report.governance.wouldBlock).toBe(3);
  expect(body.report.cost).toEqual({ monthToDateUsd: 12.5, measured: true });
  expect(body.report.enforcement.total).toBe(11);
});
