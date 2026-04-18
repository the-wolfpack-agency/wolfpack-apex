/**
 * /api/sites/insights/brief-edits route tests.
 *
 * Covers auth gate (401), admin role gate (403), happy path (200), the
 * ?days param being forwarded to the aggregator, and analytics emission.
 */

const mockGetUser = jest.fn();
const mockHasRole = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  hasRole: (...args: unknown[]) => mockHasRole(...args),
}));

const mockCompute = jest.fn();
jest.mock("@/lib/brief-edit-learning", () => ({
  computeBriefEditInsights: (...args: unknown[]) => mockCompute(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/sites/insights/brief-edits/route";

function mkReq(url = "http://test/api/sites/insights/brief-edits", auth?: string) {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new NextRequest(url, { method: "GET", headers });
}

const STUB_INSIGHTS = {
  window: { start: "2026-04-01T00:00:00.000Z", end: "2026-04-08T00:00:00.000Z", rowCount: 3 },
  acceptanceRate: { overall: 0.66, byUser: { u_1: 1 }, byModel: { haiku: 0.66 } },
  rejectionReasons: [{ reason: "user_rejected", count: 1 }],
  blockedPaths: [],
  performance: {
    latencyMs: { p50: 100, p95: 300, p99: 500 },
    tokens: { meanIn: 120, meanOut: 30 },
    totalCostUsd: 0.0012,
  },
  sectionTypeEdits: [{ sectionType: "section_0", count: 2 }],
  instructionThemes: [{ term: "hero", count: 3 }],
};

describe("GET /api/sites/insights/brief-edits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasRole.mockReturnValue(true);
  });

  it("401 without auth header", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockCompute).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("403 for sales role", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockHasRole.mockReturnValueOnce(false);
    const res = await GET(mkReq(undefined, "Bearer x"));
    expect(res.status).toBe(403);
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it("403 for ops role", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "ops" });
    mockHasRole.mockReturnValueOnce(false);
    const res = await GET(mkReq(undefined, "Bearer x"));
    expect(res.status).toBe(403);
  });

  it("200 for hr role returns insights payload", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    const res = await GET(mkReq(undefined, "Bearer x"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.insights.window.rowCount).toBe(3);
    expect(data.insights.acceptanceRate.overall).toBeCloseTo(0.66, 5);
    expect(data.insights.performance.latencyMs.p95).toBe(300);
    expect(data.insights.instructionThemes[0].term).toBe("hero");
  });

  it("200 for cto role (role gate stubbed true)", async () => {
    mockGetUser.mockReturnValue({ id: "u_cto", role: "cto" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    const res = await GET(mkReq(undefined, "Bearer x"));
    expect(res.status).toBe(200);
  });

  it("200 for ceo role (role gate stubbed true)", async () => {
    mockGetUser.mockReturnValue({ id: "u_ceo", role: "ceo" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    const res = await GET(mkReq(undefined, "Bearer x"));
    expect(res.status).toBe(200);
  });

  it("forwards ?days=30 to the aggregator", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    const res = await GET(
      mkReq("http://test/api/sites/insights/brief-edits?days=30", "Bearer x"),
    );
    expect(res.status).toBe(200);
    expect(mockCompute).toHaveBeenCalledWith({ days: 30 });
  });

  it("defaults to 7 days when ?days is missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    await GET(mkReq(undefined, "Bearer x"));
    expect(mockCompute).toHaveBeenCalledWith({ days: 7 });
  });

  it("defaults to 7 days on invalid ?days", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    await GET(
      mkReq("http://test/api/sites/insights/brief-edits?days=banana", "Bearer x"),
    );
    expect(mockCompute).toHaveBeenCalledWith({ days: 7 });
  });

  it("clamps ?days to the 90-day cap", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    await GET(
      mkReq("http://test/api/sites/insights/brief-edits?days=9999", "Bearer x"),
    );
    expect(mockCompute).toHaveBeenCalledWith({ days: 90 });
  });

  it("emits site.insights_viewed analytics with user_id, role, window_days", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockResolvedValueOnce(STUB_INSIGHTS);
    await GET(
      mkReq("http://test/api/sites/insights/brief-edits?days=30", "Bearer x"),
    );
    expect(mockTrack).toHaveBeenCalledTimes(1);
    const [event, userId, role, metadata] = mockTrack.mock.calls[0];
    expect(event).toBe("site.insights_viewed");
    expect(userId).toBe("u_hr");
    expect(role).toBe("hr");
    expect(metadata).toEqual(
      expect.objectContaining({ window_days: 30, row_count: 3 }),
    );
  });

  it("500 when aggregator throws", async () => {
    mockGetUser.mockReturnValue({ id: "u_hr", role: "hr" });
    mockCompute.mockRejectedValueOnce(new Error("db down"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(mkReq(undefined, "Bearer x"));
    expect(res.status).toBe(500);
    // 500 path should NOT emit the analytics event (we only track on
    // successful view).
    expect(mockTrack).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
