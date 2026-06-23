/**
 * Contract tests for GET /api/admin/agents/memory.
 *
 * The admin read surface for shared agent procedural memory. Covers the gate
 * (401/403), the 200 shape, the workspace scoping, and the status filter:
 * a valid status is forwarded to listMemory, an invalid one is ignored so a
 * stray query param never blanks the review queue.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockListMemory = jest.fn();
jest.mock("@/lib/agents/memory/store", () => ({
  listMemory: (...a: any[]) => mockListMemory(...a),
}));

// db is mocked so no real pool is constructed during import.
jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  writeQuery: jest.fn(),
  safeQuery: jest.fn(),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(qs = ""): any {
  return { url: `http://x/api/admin/agents/memory${qs}`, headers: new Headers() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListMemory.mockResolvedValue([]);
});

describe("GET /api/admin/agents/memory", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });
    const { GET } = await import("@/app/api/admin/agents/memory/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockListMemory).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
      }),
    });
    const { GET } = await import("@/app/api/admin/agents/memory/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
    expect(mockListMemory).not.toHaveBeenCalled();
  });

  it("200 returns the workspace-scoped memory list", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockListMemory.mockResolvedValue([
      { id: "m1", workspaceId: "default", goal: "do X", status: "promoted" },
      { id: "m2", workspaceId: "default", goal: "do Y", status: "quarantined" },
    ]);
    const { GET } = await import("@/app/api/admin/agents/memory/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace_id: string;
      memory: Array<{ id: string }>;
    };
    expect(body.workspace_id).toBe("default");
    expect(body.memory).toHaveLength(2);
    expect(body.memory[0].id).toBe("m1");
    // workspace is the first arg to listMemory, status undefined when unfiltered
    expect(mockListMemory).toHaveBeenCalledWith("default", undefined);
  });

  it("forwards a valid ?status= filter to listMemory", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/memory/route");
    const res = await GET(mkReq("?status=promoted"));
    expect(res.status).toBe(200);
    expect(mockListMemory).toHaveBeenCalledWith("default", "promoted");
  });

  it("ignores an invalid ?status= (returns all rather than 400)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/memory/route");
    const res = await GET(mkReq("?status=bogus"));
    expect(res.status).toBe(200);
    // invalid status collapses to undefined: no filter applied
    expect(mockListMemory).toHaveBeenCalledWith("default", undefined);
  });

  it("falls back to the default workspace when the user has none", async () => {
    mockRequireCap.mockResolvedValue({
      ok: true,
      user: { ...CTO, workspaceId: undefined },
    });
    const { GET } = await import("@/app/api/admin/agents/memory/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    expect(mockListMemory).toHaveBeenCalledWith("default", undefined);
  });
});
