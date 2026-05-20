/**
 * Contract tests for PATCH /api/admin/feedback/[id].
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockResolve = jest.fn();
const mockReopen = jest.fn();
jest.mock("@/lib/feedback/resolve-feedback", () => ({
  resolveFeedback: (...a: any[]) => mockResolve(...a),
  reopenFeedback: (...a: any[]) => mockReopen(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(body: unknown): any {
  return { json: async () => body, headers: new Headers() };
}
function mkParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PATCH /api/admin/feedback/[id]", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(mkReq({ action: "resolve" }), mkParams("f1"));
    expect(res.status).toBe(403);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("400 missing/invalid action", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const r1 = await PATCH(mkReq({}), mkParams("f1"));
    expect(r1.status).toBe(400);
    const r2 = await PATCH(mkReq({ action: "delete" }), mkParams("f1"));
    expect(r2.status).toBe(400);
  });

  it("200 resolve: calls resolveFeedback with workspaceId + user + note", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockResolve.mockResolvedValueOnce({ id: "f1", resolved_at: "t", resolved_by: CTO.id, resolution_note: "fix" });
    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(mkReq({ action: "resolve", note: "fix" }), mkParams("f1"));
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "default",
      feedbackId: "f1",
      resolverId: CTO.id,
      resolverRole: CTO.role,
      note: "fix",
    }));
  });

  it("200 reopen: calls reopenFeedback", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockReopen.mockResolvedValueOnce({ id: "f1", resolved_at: null, resolved_by: null, resolution_note: null });
    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(mkReq({ action: "reopen" }), mkParams("f1"));
    expect(res.status).toBe(200);
    expect(mockReopen).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "default",
      feedbackId: "f1",
      reopenerId: CTO.id,
    }));
  });

  it("404 when lib throws not-found", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockResolve.mockRejectedValueOnce(new Error("row not found in workspace"));
    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(mkReq({ action: "resolve" }), mkParams("missing"));
    expect(res.status).toBe(404);
  });
});
