/**
 * Contract for GET /api/admin/ai-router.
 *
 * 200 / 401 asserted, plus the window clamp. An unclamped `days` is a full scan
 * of the event table from an unauthenticated-adjacent surface, which is a
 * denial-of-service with a query string.
 */
const mockGetRouterInsights = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/ai/models/insights", () => ({
  getRouterInsights: (...a: unknown[]) => mockGetRouterInsights(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const get = (qs = "") => new NextRequest(`http://localhost/api/admin/ai-router${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockGetRouterInsights.mockResolvedValue({ days: 30, models: [], usage: [], totalDecisions: 0 });
});

describe("GET", () => {
  it("returns 200 with the router's activity", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).days).toBe(30);
  });

  it("returns 401 when unauthenticated, rather than an empty report", async () => {
    // An empty report reads as "the router is idle", which is a claim.
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET(get())).status).toBe(401);
    expect(mockGetRouterInsights).not.toHaveBeenCalled();
  });

  it("honours a window", async () => {
    await GET(get("?days=7"));
    expect(mockGetRouterInsights).toHaveBeenCalledWith(7);
  });

  it("clamps an unbounded window instead of scanning the whole event table", async () => {
    await GET(get("?days=999999"));
    expect(mockGetRouterInsights).toHaveBeenCalledWith(180);
  });

  it.each(["?days=0", "?days=-1", "?days=abc", ""])("falls back to the default for '%s'", async (qs) => {
    await GET(get(qs));
    expect(mockGetRouterInsights).toHaveBeenCalledWith(30);
  });
});
