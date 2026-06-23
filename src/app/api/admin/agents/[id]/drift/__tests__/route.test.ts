/**
 * Contract tests for GET /api/admin/agents/[id]/drift.
 *
 *   - unauthenticated -> 401 (gated on settings.manage_team).
 *   - happy path -> 200 { baseline, events, latest } scoped to the workspace.
 *   - empty state -> 200 { baseline: null, events: [], latest: null }.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockGetBaseline = jest.fn();
const mockListDriftEvents = jest.fn();
jest.mock("@/lib/agents/drift/store", () => ({
  getBaseline: (...a: any[]) => mockGetBaseline(...a),
  listDriftEvents: (...a: any[]) => mockListDriftEvents(...a),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(),
  writeQuery: jest.fn(),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const BASELINE = {
  agentId: "a_1",
  workspaceId: "default",
  metrics: { count: 120 },
  decisionCount: 120,
  capturedAt: "2026-06-19T00:00:00.000Z",
};

const EVENTS = [
  { id: "e2", agentId: "a_1", driftScore: 0.4, verdict: "drifting", action: "none", createdAt: "2026-06-19T02:00:00.000Z" },
  { id: "e1", agentId: "a_1", driftScore: 0.1, verdict: "stable", action: "none", createdAt: "2026-06-19T01:00:00.000Z" },
];

function mkReq(): any {
  return { url: "http://x/api/admin/agents/a_1/drift", headers: new Headers() };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBaseline.mockResolvedValue(BASELINE);
  mockListDriftEvents.mockResolvedValue(EVENTS);
});

describe("GET /api/admin/agents/[id]/drift", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/drift/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(401);
    expect(mockGetBaseline).not.toHaveBeenCalled();
    expect(mockListDriftEvents).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/drift/route");
    await GET(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("200 returns { baseline, events, latest } scoped to the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/drift/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseline: { agentId: string };
      events: Array<{ id: string }>;
      latest: { id: string } | null;
    };
    expect(body.baseline.agentId).toBe("a_1");
    expect(body.events).toHaveLength(2);
    expect(body.latest?.id).toBe("e2");
    expect(mockGetBaseline).toHaveBeenCalledWith("a_1", "default");
    expect(mockListDriftEvents).toHaveBeenCalledWith("a_1", "default");
  });

  it("200 with explicit empty state when there is no history", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetBaseline.mockResolvedValue(null);
    mockListDriftEvents.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/agents/[id]/drift/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseline: unknown;
      events: unknown[];
      latest: unknown;
    };
    expect(body.baseline).toBeNull();
    expect(body.events).toEqual([]);
    expect(body.latest).toBeNull();
  });
});
