/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/forcefield/trips: auth (401/403) and that it
 * returns the workspace's trips via listCanaryTrips (mocked - no DB).
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockListTrips = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/forcefield/triage", () => ({ listCanaryTrips: (...a: unknown[]) => mockListTrips(...a) }));

import { GET } from "../route";

const OK_USER = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const req = () => new NextRequest("http://localhost/api/admin/forcefield/trips");
const TRIP = { id: "t1", agent: "agent-x", whenIso: "2026-09-17T01:00:00.000Z", riskTier: "critical", reason: "trip", contained: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK_USER);
  mockListTrips.mockResolvedValue([TRIP]);
});

test("401 without a session", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
});
test("403 without settings.manage_team", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});
test("200 returns the workspace's trips", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(mockListTrips).toHaveBeenCalledWith("w1");
  const body = await res.json();
  expect(body.trips[0].agent).toBe("agent-x");
});
