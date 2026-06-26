/**
 * Contract tests for /api/admin/agents/[id]/backup (migration 184).
 *
 * GET:
 *   - 403 without settings.manage_team.
 *   - 200 returns { backupAgentId }.
 * POST body { backupAgentId }:
 *   - 403 without settings.manage_team.
 *   - 200 sets a valid backup (delegates to setBackupAgent).
 *   - 200 clears the backup with null.
 *   - 400 on a self / cycle / cross-workspace reject (the failover invariant).
 *   - 404 when the agent or backup is not found.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSetBackup = jest.fn();
const mockGetBackupId = jest.fn();
jest.mock("@/lib/agents/failover/store", () => ({
  setBackupAgent: (...a: any[]) => mockSetBackup(...a),
  getBackupAgentId: (...a: any[]) => mockGetBackupId(...a),
}));

// Imported by the route for the audit-coverage guard; never invoked directly.
jest.mock("@/lib/audit-log", () => ({ recordAudit: jest.fn() }));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(body?: unknown): any {
  return {
    url: "http://x/api/admin/agents/a_1/backup",
    headers: new Headers(),
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
  mockSetBackup.mockResolvedValue({ ok: true });
  mockGetBackupId.mockResolvedValue(null);
});

describe("GET /api/admin/agents/[id]/backup", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(403);
    expect(mockGetBackupId).not.toHaveBeenCalled();
  });

  it("200 returns the current backup id", async () => {
    mockGetBackupId.mockResolvedValue("a_backup");
    const { GET } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backupAgentId: string | null };
    expect(body.backupAgentId).toBe("a_backup");
    expect(mockGetBackupId).toHaveBeenCalledWith("default", "a_1");
  });
});

describe("POST /api/admin/agents/[id]/backup", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "a_backup" }), ctx("a_1"));
    expect(res.status).toBe(403);
    expect(mockSetBackup).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    await POST(mkReq({ backupAgentId: "a_backup" }), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("200 sets a valid backup and delegates to setBackupAgent", async () => {
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "a_backup" }), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; backupAgentId: string | null };
    expect(body.ok).toBe(true);
    expect(body.backupAgentId).toBe("a_backup");
    expect(mockSetBackup).toHaveBeenCalledWith("default", "a_1", "a_backup", {
      userId: "u_cto",
      role: "cto",
    });
  });

  it("200 clears the backup with null", async () => {
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: null }), ctx("a_1"));
    expect(res.status).toBe(200);
    expect(mockSetBackup).toHaveBeenCalledWith("default", "a_1", null, expect.any(Object));
  });

  it("treats an empty string as a clear (null)", async () => {
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "" }), ctx("a_1"));
    expect(res.status).toBe(200);
    expect(mockSetBackup).toHaveBeenCalledWith("default", "a_1", null, expect.any(Object));
  });

  it("400 when the backup would be self (invariant violation)", async () => {
    mockSetBackup.mockResolvedValue({ ok: false, code: "backup_is_self" });
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "a_1" }), ctx("a_1"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("backup_is_self");
  });

  it("400 on a cycle reject", async () => {
    mockSetBackup.mockResolvedValue({ ok: false, code: "backup_cycle" });
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "a_backup" }), ctx("a_1"));
    expect(res.status).toBe(400);
  });

  it("404 when the agent is not found", async () => {
    mockSetBackup.mockResolvedValue({ ok: false, code: "agent_not_found" });
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "a_backup" }), ctx("a_missing"));
    expect(res.status).toBe(404);
  });

  it("404 when the backup is not found", async () => {
    mockSetBackup.mockResolvedValue({ ok: false, code: "backup_not_found" });
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: "a_ghost" }), ctx("a_1"));
    expect(res.status).toBe(404);
  });

  it("400 on a non-string, non-null backupAgentId", async () => {
    const { POST } = await import("@/app/api/admin/agents/[id]/backup/route");
    const res = await POST(mkReq({ backupAgentId: 42 }), ctx("a_1"));
    expect(res.status).toBe(400);
    expect(mockSetBackup).not.toHaveBeenCalled();
  });
});
