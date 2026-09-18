/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/effectiveness/cost. computeCostUsage mocked - no DB.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockCompute = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/effectiveness/cost", () => ({
  computeCostUsage: (...a: unknown[]) => mockCompute(...a),
  liveCostDeps: () => ({}),
}));

import { GET } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = (qs = "") => new NextRequest(`http://localhost/api/admin/effectiveness/cost${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockCompute.mockResolvedValue({ sinceIso: "x", totalCostUsd: 0.15, totalCalls: 140, totalInputTokens: 0, totalOutputTokens: 0, byModel: [] });
});

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});
it("200 returns the workspace-scoped report and defaults to a 30-day window", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.windowDays).toBe(30);
  expect(body.report.totalCostUsd).toBe(0.15);
  expect(mockCompute.mock.calls[0][0]).toBe("w1"); // workspace-scoped
});
it("honors + clamps the days param", async () => {
  await GET(req("?days=7"));
  await GET(req("?days=9999"));
  await GET(req("?days=0"));
  // windowDays returned reflects the clamp; we assert via a fresh call's body.
  const res = await GET(req("?days=7"));
  expect((await res.json()).windowDays).toBe(7);
  const big = await GET(req("?days=9999"));
  expect((await big.json()).windowDays).toBe(365);
  const zero = await GET(req("?days=0"));
  expect((await zero.json()).windowDays).toBe(1);
});
