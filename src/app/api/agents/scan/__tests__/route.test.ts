/**
 * Contract tests for POST /api/agents/scan: the agent self-onboarding scan.
 *
 *   - no / invalid agent token -> 401 invalid_token (no DB load, no scan run).
 *   - revoked or paused agent (even with a valid token) -> 403 agent_not_active.
 *   - missing agent record -> 403 agent_not_active.
 *   - happy path -> 200 { ok, summary, scan_version }, saveScan called, no-store.
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

const mockRunScan = jest.fn();
jest.mock("@/lib/agents/scan", () => ({
  runSelfOnboardingScan: (...a: any[]) => mockRunScan(...a),
}));

const mockSaveScan = jest.fn();
jest.mock("@/lib/agents/scan-store", () => ({
  saveScan: (...a: any[]) => mockSaveScan(...a),
}));

const PRINCIPAL = {
  agentId: "a_1",
  role: "ops",
  workspaceId: "default",
  ownerUserId: "u_cto",
  provider: "local",
};

const MODEL = {
  scanVersion: "agent-scan-2026-06-24.1",
  agentId: "a_1",
  role: "ops",
  workspaceId: "default",
  capabilities: ["c1"],
  tools: [],
  summary: { toolCount: 12, allowedToolCount: 4, mutationCount: 3, capabilityCount: 1 },
};

function mkReq(auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return { url: "http://x/api/agents/scan", headers };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "active" });
  mockRunScan.mockReturnValue(MODEL);
  mockSaveScan.mockResolvedValue({ id: "scan_1" });
});

describe("POST /api/agents/scan", () => {
  it("401 invalid_token when no agent token resolves", async () => {
    mockResolve.mockResolvedValue(null);
    const { POST } = await import("@/app/api/agents/scan/route");
    const res = await POST(mkReq());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token");
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockRunScan).not.toHaveBeenCalled();
    expect(mockSaveScan).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("403 agent_not_active when the agent is revoked", async () => {
    mockResolve.mockResolvedValue(PRINCIPAL);
    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "revoked" });
    const { POST } = await import("@/app/api/agents/scan/route");
    const res = await POST(mkReq("Bearer tok"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_active");
    // A revoked agent's still-valid token must never run or persist a scan.
    expect(mockRunScan).not.toHaveBeenCalled();
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("403 agent_not_active when the agent is paused", async () => {
    mockResolve.mockResolvedValue(PRINCIPAL);
    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "paused" });
    const { POST } = await import("@/app/api/agents/scan/route");
    const res = await POST(mkReq("Bearer tok"));
    expect(res.status).toBe(403);
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("403 agent_not_active when the agent record is missing", async () => {
    mockResolve.mockResolvedValue(PRINCIPAL);
    mockGetAgent.mockResolvedValue(null);
    const { POST } = await import("@/app/api/agents/scan/route");
    const res = await POST(mkReq("Bearer tok"));
    expect(res.status).toBe(403);
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("200 returns the summary + scan_version, persists the scan, no-store", async () => {
    mockResolve.mockResolvedValue(PRINCIPAL);
    const { POST } = await import("@/app/api/agents/scan/route");
    const res = await POST(mkReq("Bearer tok"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      summary: { toolCount: number; allowedToolCount: number };
      scan_version: string;
    };
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual(MODEL.summary);
    expect(body.scan_version).toBe("agent-scan-2026-06-24.1");

    // Scan is run for the resolved principal and persisted.
    expect(mockRunScan).toHaveBeenCalledWith({
      agentId: "a_1",
      role: "ops",
      workspaceId: "default",
    });
    expect(mockSaveScan).toHaveBeenCalledWith(MODEL);

    // State is verified from the DB scoped to the token's workspace.
    expect(mockGetAgent).toHaveBeenCalledWith("a_1", "default");

    // The full model is NOT returned (only the summary).
    expect(JSON.stringify(body)).not.toContain('"tools"');

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
