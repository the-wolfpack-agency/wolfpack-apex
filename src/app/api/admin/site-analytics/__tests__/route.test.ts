/**
 * Contract: GET /api/admin/site-analytics is capability-gated (analytics.view)
 * and returns the aggregated summary. The lib is mocked.
 */
export {};

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockGetSummary = jest.fn();
jest.mock("@/lib/site-analytics", () => ({
  getSiteAnalyticsSummary: (...a: unknown[]) => mockGetSummary(...a),
}));

import { GET } from "@/app/api/admin/site-analytics/route";

function mkReq(qs = ""): any {
  return new Request(`http://test/api/admin/site-analytics${qs}`, { method: "GET" }) as any;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/admin/site-analytics", () => {
  it("403 when the capability gate denies", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    mockRequireCapability.mockResolvedValue({ ok: false, response: denied });
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
    expect(mockGetSummary).not.toHaveBeenCalled();
  });

  it("200 with the summary, honoring the days param", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.view", "analytics.triage", "settings.manage_team"]) });
    mockGetSummary.mockResolvedValue({ rangeDays: 7, totalPageViews: 5, totalEvents: 9, byHour: [], byPage: [], byCountry: [], byType: [] });
    const res = await GET(mkReq("?days=7"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.rangeDays).toBe(7);
    expect(mockGetSummary).toHaveBeenCalledWith(7, "w1", "all");
  });

  it("passes a valid surface filter through, and rejects a malformed one to 'all'", async () => {
    mockGetSummary.mockResolvedValue({ rangeDays: 30 });
    await GET(mkReq("?days=30&surface=instinct"));
    expect(mockGetSummary).toHaveBeenLastCalledWith(30, "w1", "instinct");
    await GET(mkReq("?days=30&surface=%20drop%20table"));
    expect(mockGetSummary).toHaveBeenLastCalledWith(30, "w1", "all"); // malformed -> safe default
  });

  it("reports the caller's write permissions so the UI hides controls it can't use", async () => {
    // A privileged caller: both write scopes true.
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.view", "analytics.triage", "settings.manage_team"]) });
    mockGetSummary.mockResolvedValue({ rangeDays: 30, totalPageViews: 0, totalEvents: 0, byHour: [], byPage: [], byCountry: [], byType: [] });
    let body = await (await GET(mkReq())).json();
    expect(body.permissions).toEqual({ triage: true, manageOperators: true, viewIntel: false });

    // A read-only viewer (has analytics.view via SELF_SERVICE, no write scopes).
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: { id: "u2", role: "sales", workspaceId: "w1" }, capabilities: new Set(["analytics.view"]) });
    body = await (await GET(mkReq())).json();
    expect(body.permissions).toEqual({ triage: false, manageOperators: false, viewIntel: false });

    // a holder of forcefield.view sees the deep agent-defense intel
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: { id: "u3", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.view", "forcefield.view"]) });
    body = await (await GET(mkReq())).json();
    expect(body.permissions.viewIntel).toBe(true);
  });
});

  it("returns deep intel only to forcefield.view holders; strips it for everyone else", async () => {
    const full = {
      rangeDays: 30, surfaces: ["all"], totalPageViews: 5, collectsPageViews: true, totalEvents: 9,
      byHour: [], byPage: [], byCountry: [], byType: [],
      forcefield: { welcomed: 1, flagged: 0, trapped: 0, blocked: 0, hostileOperators: 0, hostileEvents: 0, topAgents: [] },
      agentOrigins: [],
      // deep intel:
      learnedSignatures: { shadow: 1, enforcing: 2, autoBlocked: 3 },
      agentIntel: { operators: 4 },
      journeys: [{ key: "j1" }],
      probeIntel: [{ path: "/x" }],
      payloadIntel: [{ attack: "sqli", count: 1 }],
    };

    // with forcefield.view -> full intel
    mockGetSummary.mockResolvedValue(full);
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.view", "forcefield.view"]) });
    let body = await (await GET(mkReq())).json();
    expect(body.summary.agentIntel).toBeDefined();
    expect(body.summary.journeys).toHaveLength(1);
    expect(body.summary.learnedSignatures).toBeDefined();

    // without it -> usage kept, every deep-intel key absent
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: { id: "u2", role: "sales", workspaceId: "w1" }, capabilities: new Set(["analytics.view"]) });
    body = await (await GET(mkReq())).json();
    expect(body.summary.totalPageViews).toBe(5);
    expect(body.summary.forcefield).toBeDefined();   // high-level summary stays
    for (const k of ["agentIntel", "journeys", "learnedSignatures", "probeIntel", "payloadIntel"]) {
      expect(body.summary[k]).toBeUndefined();
    }
  });
