/**
 * Contract tests for GET /api/admin/ogiam/trends.
 *
 * Asserts the auth contract (401 unauth, 403 missing capability), the 200 shape
 * (workspace_id + the three day-bucketed series + window), the 503 when no
 * DATABASE_URL, and that ogiam.trends_viewed fires on a successful read. The
 * trends lib + analytics are mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockGovernanceTrends = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ogiam/trends", () => ({
  ...jest.requireActual("@/lib/ogiam/trends"),
  governanceTrends: (...a: unknown[]) => mockGovernanceTrends(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const req = (qs = "") =>
  new NextRequest(`https://x.test/api/admin/ogiam/trends${qs}`, { method: "GET" });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
const allow = () => ({
  ok: true,
  user: { id: "u-1", role: "admin", workspaceId: "ws-1" },
  capabilities: new Set(),
});

const sampleTrends = {
  window_days: 30,
  decisions: [{ day: "2026-06-28", total: 3, would_block: 1 }],
  redteam: [{ day: "2026-06-28", pass_rate: 1, vulns: 0, runs: 1 }],
  surfaces: [{ day: "2026-06-28", new_ungoverned: 2, cumulative_ungoverned: 2 }],
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DATABASE_URL = "postgres://x";
  mockGovernanceTrends.mockResolvedValue(sampleTrends);
});

afterAll(() => {
  delete process.env.DATABASE_URL;
});

test("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
  expect(mockGovernanceTrends).not.toHaveBeenCalled();
});

test("403 when the caller lacks settings.manage_team", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
});

test("503 when no DATABASE_URL", async () => {
  delete process.env.DATABASE_URL;
  mockRequireCapability.mockResolvedValue(allow());
  expect((await GET(req())).status).toBe(503);
});

test("200 returns the workspace-scoped trends shape and fires ogiam.trends_viewed", async () => {
  mockRequireCapability.mockResolvedValue(allow());
  const res = await GET(req("?window=30"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    workspace_id: "ws-1",
    window_days: 30,
    decisions: expect.any(Array),
    redteam: expect.any(Array),
    surfaces: expect.any(Array),
  });
  // Workspace-scoped: the trends query is called for the caller's workspace.
  expect(mockGovernanceTrends).toHaveBeenCalledWith("ws-1", 30);
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ogiam.trends_viewed",
    "u-1",
    "admin",
    expect.objectContaining({ window_days: 30 }),
  );
});
