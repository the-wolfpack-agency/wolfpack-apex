/**
 * @jest-environment node
 *
 * Contract for GET /api/forcefield-web/protection. computeWebProtection mocked.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockCompute = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/forcefield-web/rollup", () => ({
  computeWebProtection: (...a: unknown[]) => mockCompute(...a),
  liveWebProtectionDeps: () => ({}),
}));

import { GET } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = () => new NextRequest("http://localhost/api/forcefield-web/protection");

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue(OK);
  mockCompute.mockResolvedValue({ inspected: 9, welcomed: 3, allowed: 4, reported: 1, blocked: 1, decoyTrips: 1, sampleCapped: false });
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
  expect(body.report.inspected).toBe(9);
  expect(body.report.decoyTrips).toBe(1);
});
