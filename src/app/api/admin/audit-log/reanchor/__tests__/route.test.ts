/**
 * Contract tests for POST /api/admin/audit-log/reanchor.
 *
 * 403 without settings.manage_team; 400 on bad/missing seq or reason;
 * 200 with the reanchorChain result on success.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockReanchor = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  reanchorChain: (...a: any[]) => mockReanchor(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(body: unknown): any {
  return {
    url: "https://app/api/admin/audit-log/reanchor",
    headers: new Headers(),
    json: async () => body,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/admin/audit-log/reanchor", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/audit-log/reanchor/route");
    const res = await POST(mkReq({ seq: 509, reason: "x" }));
    expect(res.status).toBe(403);
    expect(mockReanchor).not.toHaveBeenCalled();
  });

  it("400 when seq is missing / not a positive integer", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/audit-log/reanchor/route");

    for (const bad of [{}, { seq: 0, reason: "x" }, { seq: -3, reason: "x" }, { seq: "abc", reason: "x" }, { seq: 1.5, reason: "x" }]) {
      const res = await POST(mkReq(bad));
      expect(res.status).toBe(400);
    }
    expect(mockReanchor).not.toHaveBeenCalled();
  });

  it("400 when reason is missing / blank", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/audit-log/reanchor/route");

    for (const bad of [{ seq: 509 }, { seq: 509, reason: "" }, { seq: 509, reason: "   " }]) {
      const res = await POST(mkReq(bad));
      expect(res.status).toBe(400);
    }
    expect(mockReanchor).not.toHaveBeenCalled();
  });

  it("200 and returns the reanchor result on success", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockReanchor.mockResolvedValueOnce({
      seq: 509,
      reason: "concurrency fork at 509",
      acknowledgedBy: "u_cto",
      alreadyAnchored: false,
    });
    const { POST } = await import("@/app/api/admin/audit-log/reanchor/route");

    const res = await POST(mkReq({ seq: 509, reason: "concurrency fork at 509" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({ seq: 509, acknowledgedBy: "u_cto", alreadyAnchored: false }),
    );

    // Called with seq, reason, and the actor derived from the authed user.
    expect(mockReanchor).toHaveBeenCalledWith(509, "concurrency fork at 509", {
      user_id: "u_cto",
      role: "cto",
    });
  });
});
