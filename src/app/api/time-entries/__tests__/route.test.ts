/**
 * Contract tests for /api/time-entries.
 */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockRecord = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/time-entries", () => ({
  recordTimeEntry: (...a: any[]) => mockRecord(...a),
  listTimeEntries: (...a: any[]) => mockList(...a),
}));

const USER = { id: "tm_x", email: "u@x.com", role: "ops", workspaceId: "default" };

function mkReq(body: unknown, url = "https://app/api/time-entries", auth = "Bearer t"): any {
  return { json: async () => body, url, headers: new Headers({ authorization: auth }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue(USER);
});

describe("POST /api/time-entries", () => {
  it("401 unauthenticated", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const { POST } = await import("@/app/api/time-entries/route");
    const res = await POST(mkReq({ job_code: "X", hours: 1 }));
    expect(res.status).toBe(401);
  });

  it("400 invalid body", async () => {
    const { POST } = await import("@/app/api/time-entries/route");
    const res = await POST(mkReq(null));
    expect(res.status).toBe(400);
  });

  it("201 happy path: recordTimeEntry called with user.* context", async () => {
    mockRecord.mockResolvedValueOnce({ id: "e1", job_code: "X", hours: 1 });
    const { POST } = await import("@/app/api/time-entries/route");
    const res = await POST(mkReq({ job_code: "X", hours: 1.5, notes: "x" }));
    expect(res.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: USER.workspaceId,
      userId: USER.id,
      userEmail: USER.email,
      userRole: USER.role,
      jobCode: "X",
      hours: 1.5,
      notes: "x",
    }));
  });

  it("400 when lib throws validation error", async () => {
    mockRecord.mockRejectedValueOnce(new Error("hours must be in (0, 24]"));
    const { POST } = await import("@/app/api/time-entries/route");
    const res = await POST(mkReq({ job_code: "X", hours: 100 }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/time-entries", () => {
  it("401 unauthenticated", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const { GET } = await import("@/app/api/time-entries/route");
    const res = await GET(mkReq({}));
    expect(res.status).toBe(401);
  });

  it("200 lists entries scoped to caller", async () => {
    mockList.mockResolvedValueOnce([{ id: "e1" }]);
    const { GET } = await import("@/app/api/time-entries/route");
    const res = await GET(mkReq({}, "https://app/api/time-entries?since=2026-05-01&limit=10"));
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: USER.workspaceId,
      userId: USER.id,
      since: "2026-05-01",
      limit: 10,
    }));
  });
});
