/**
 * Contract for GET /api/admin/ai-router.
 *
 * 200 / 401 asserted, plus the window clamp. An unclamped `days` is a full scan
 * of the event table from an unauthenticated-adjacent surface, which is a
 * denial-of-service with a query string.
 */
const mockGetRouterInsights = jest.fn();
const okAs = (role: string, caps: string[]) => async () => ({
  ok: true,
  user: { id: `${role}-1`, role, workspaceId: "ws-1" },
  /* requireCapability returns the RESOLVED SET, and the route reads it to
     decide whether this caller may run the probe. A mock without it is a mock
     of a function that does not exist. */
  capabilities: new Set(caps),
});

let mockAuth: () => Promise<unknown> = okAs("admin", ["router.view", "settings.manage_team"]);

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/ai/models/insights", () => ({
  getRouterInsights: (...a: unknown[]) => mockGetRouterInsights(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const get = (qs = "") => new NextRequest(`http://localhost/api/admin/ai-router${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = okAs("admin", ["router.view", "settings.manage_team"]);
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

/**
 * READING THE ROUTER IS ORG-WIDE, SPENDING IS NOT.
 *
 * This was gated on settings.manage_team, which is the right gate for changing
 * the team and the wrong one for looking at how a model was chosen: five of the
 * ten roles could not see the part of the product that is hardest to believe
 * without seeing, and the people best placed to notice a wrong answer are the
 * ones using the assistant all day.
 *
 * The payload is aggregate by construction. Counts, prices, reason codes and
 * rule ids; refusals carry rule ids and never a sentence, and blockedBy names a
 * missing environment variable rather than its value.
 */
describe("who can read it", () => {
  it("lets a seat with only the view capability read it", async () => {
    mockAuth = okAs("sales", ["router.view"]);
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).days).toBe(30);
  });

  it("tells that seat it may NOT run the probe", async () => {
    // The probe sends a real inference call to every configured provider.
    // Offering a button that answers 403 is a menu of disappointments.
    mockAuth = okAs("sales", ["router.view"]);
    expect((await GET(get()).then((r) => r.json())).canProbe).toBe(false);
  });

  it("tells a seat that manages the deployment it may", async () => {
    expect((await GET(get()).then((r) => r.json())).canProbe).toBe(true);
  });

  it("answers canProbe from the resolved set, not from the role name", async () => {
    /* A per-user grant is real: capability overrides layer on top of the role
       default. Deciding from the role string would ignore them, and would be a
       second copy of a rule the gate already applied. */
    mockAuth = okAs("designer", ["router.view", "settings.manage_team"]);
    expect((await GET(get()).then((r) => r.json())).canProbe).toBe(true);
  });
});
