/**
 * Contract tests for POST /api/agents/act: the governed agent action loop.
 *
 *   - no / invalid agent token -> 401 invalid_token.
 *   - revoked / paused / missing agent -> 403 agent_not_active (no dispatch).
 *   - empty / oversized message -> 400.
 *   - happy path -> 200 { ok, dispatched: { tool, result } }, agent.acted fired
 *     with the right principal + allowed flag, no-store, enforce-mode ctx.
 *   - per-agent rate limit -> 429 with Retry-After.
 */

export {};

const mockResolve = jest.fn();
jest.mock("@/lib/agents/identity", () => ({
  resolveAgentFromRequest: (...a: any[]) => mockResolve(...a),
}));

const mockGetAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: any[]) => mockGetAgent(...a),
}));

const mockDispatch = jest.fn();
jest.mock("@/lib/assistant/tools/dispatcher", () => ({
  tryDispatchTool: (...a: any[]) => mockDispatch(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const PRINCIPAL = {
  agentId: "a_1",
  role: "ops",
  workspaceId: "default",
  ownerUserId: "u_cto",
  provider: "local",
};

function mkReq(body: unknown, auth = "Bearer tok"): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return { url: "http://x/api/agents/act", headers, json: async () => body };
}

async function freshRoute() {
  const mod = await import("@/app/api/agents/act/route");
  mod._resetRateLimit();
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue(PRINCIPAL);
  mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "active" });
  mockDispatch.mockResolvedValue({
    tool: "search",
    result: { ok: true, data: {}, answer: "found" },
    durationMs: 5,
  });
});

describe("POST /api/agents/act", () => {
  it("401 invalid_token when no agent token resolves", async () => {
    mockResolve.mockResolvedValue(null);
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "hi" }, ""));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("403 agent_not_active when the agent is revoked", async () => {
    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "revoked" });
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "hi" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_active");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("403 agent_not_active when the agent is paused or missing", async () => {
    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "paused" });
    const { POST } = await freshRoute();
    let res = await POST(mkReq({ message: "hi" }));
    expect(res.status).toBe(403);

    mockGetAgent.mockResolvedValue(null);
    res = await POST(mkReq({ message: "hi" }));
    expect(res.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("400 when message is empty", async () => {
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "   " }));
    expect(res.status).toBe(400);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("400 when message exceeds 2000 chars", async () => {
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("200 returns the dispatched tool result and fires agent.acted (allowed=true)", async () => {
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "search for X" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      dispatched: { tool: string; result: { ok: boolean } } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.dispatched?.tool).toBe("search");
    expect(body.dispatched?.result.ok).toBe(true);

    // Dispatch runs in enforce mode: the agentPrincipal is threaded through.
    const [msg, ctx] = mockDispatch.mock.calls[0];
    expect(msg).toBe("search for X");
    expect(ctx.userId).toBe("a_1");
    expect(ctx.userRole).toBe("ops");
    expect(ctx.workspaceId).toBe("default");
    expect(ctx.agentPrincipal).toEqual({
      agentId: "a_1",
      role: "ops",
      workspaceId: "default",
      ownerUserId: "u_cto",
    });

    // agent.acted is fired for the learning loop with the allowed flag.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.acted",
      "a_1",
      "ops",
      expect.objectContaining({ agent_id: "a_1", tool: "search", allowed: true }),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fires agent.acted with allowed=false when the gate blocked the action", async () => {
    mockDispatch.mockResolvedValue({
      tool: "mail.send",
      result: { ok: false, code: "capability", message: "OGIAM deny" },
      durationMs: 2,
    });
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "send mail" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatched: { result: { ok: boolean } } };
    // The blocked decision is surfaced, not thrown.
    expect(body.dispatched.result.ok).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.acted",
      "a_1",
      "ops",
      expect.objectContaining({ tool: "mail.send", allowed: false }),
    );
  });

  it("dispatched is null and tool is 'none' when no tool matched", async () => {
    mockDispatch.mockResolvedValue(null);
    const { POST } = await freshRoute();
    const res = await POST(mkReq({ message: "small talk" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatched: unknown };
    expect(body.dispatched).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.acted",
      "a_1",
      "ops",
      expect.objectContaining({ tool: "none", allowed: false }),
    );
  });

  it("429 once the per-agent rate limit is exceeded", async () => {
    const { POST } = await freshRoute();
    let last: any;
    // 30 allowed in the window, the 31st trips the limiter.
    for (let i = 0; i < 31; i++) {
      last = await POST(mkReq({ message: "search" }));
    }
    expect(last.status).toBe(429);
    const body = (await last.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(last.headers.get("Retry-After")).toBeTruthy();
    expect(last.headers.get("Cache-Control")).toBe("no-store");
  });
});
