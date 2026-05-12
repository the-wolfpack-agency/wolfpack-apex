/**
 * API contract tests: /api/messages/read-state.
 *
 *   GET   401 without auth
 *   GET   200 returns { state: {} } for new user
 *   GET   200 returns { state: { c1: ISO } } for user with one row
 *   GET   200 returns { last_read_at: ISO|null } when ?chat_id=X
 *   POST  401 without auth
 *   POST  400 missing chat_id
 *   POST  400 missing last_read_at
 *   POST  400 invalid last_read_at
 *   POST  200 happy path → fires lib + returns persisted ts
 *   POST  500 propagates lib write error
 */
 

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockGetReadState = jest.fn();
const mockSetReadState = jest.fn();
jest.mock("@/lib/messages/read-state", () => ({
  getReadState: (...a: any[]) => mockGetReadState(...a),
  setReadState: (...a: any[]) => mockSetReadState(...a),
}));

class WriteQueryError extends Error {
  code: string;
  constructor(msg: string, code: string) {
    super(msg);
    this.code = code;
  }
}
jest.mock("@/lib/db", () => ({ WriteQueryError }));

function mkReq(path: string, init: any = {}): any {
  const headers = new Headers(init.headers || {});
  return new Request(`http://test${path}`, { ...init, headers }) as any;
}

const USER = { id: "u1", email: "a@x.com", role: "dev" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/messages/read-state", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/messages/read-state/route");
    const res = await GET(mkReq("/api/messages/read-state"));
    expect(res.status).toBe(401);
  });

  it("200 { state: {} } for new user (no rows)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetReadState.mockResolvedValue(new Map());
    const { GET } = await import("@/app/api/messages/read-state/route");
    const res = await GET(
      mkReq("/api/messages/read-state", { headers: { authorization: "Bearer x" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ state: {} });
  });

  it("200 { state: { c1, c2 } } for existing rows", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetReadState.mockResolvedValue(
      new Map([
        ["c1", "2026-04-29T10:00:00.000Z"],
        ["c2", "2026-04-28T09:00:00.000Z"],
      ]),
    );
    const { GET } = await import("@/app/api/messages/read-state/route");
    const res = await GET(
      mkReq("/api/messages/read-state", { headers: { authorization: "Bearer x" } }),
    );
    const body = await res.json();
    expect(body.state).toEqual({
      c1: "2026-04-29T10:00:00.000Z",
      c2: "2026-04-28T09:00:00.000Z",
    });
  });

  it("200 { last_read_at: ISO|null } when ?chat_id=X", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetReadState.mockResolvedValue(
      new Map([["c1", "2026-04-29T10:00:00.000Z"]]),
    );
    const { GET } = await import("@/app/api/messages/read-state/route");
    const hit = await GET(
      mkReq("/api/messages/read-state?chat_id=c1", {
        headers: { authorization: "Bearer x" },
      }),
    );
    expect(await hit.json()).toEqual({
      last_read_at: "2026-04-29T10:00:00.000Z",
    });

    const miss = await GET(
      mkReq("/api/messages/read-state?chat_id=cX", {
        headers: { authorization: "Bearer x" },
      }),
    );
    expect(await miss.json()).toEqual({ last_read_at: null });
  });

  it("500 on lib throw", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetReadState.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/messages/read-state/route");
    const res = await GET(
      mkReq("/api/messages/read-state", { headers: { authorization: "Bearer x" } }),
    );
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});

describe("POST /api/messages/read-state", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({ chat_id: "c1", last_read_at: "2026-04-29T10:00:00.000Z" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("400 missing chat_id", async () => {
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({ last_read_at: "2026-04-29T10:00:00.000Z" }),
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/chat_id/);
  });

  it("400 missing last_read_at", async () => {
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({ chat_id: "c1" }),
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 invalid last_read_at", async () => {
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({ chat_id: "c1", last_read_at: "not-a-date" }),
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 invalid JSON body", async () => {
    mockGetUser.mockReturnValue(USER);
    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: "not-json",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("200 happy path — calls setReadState + returns persisted ts", async () => {
    mockGetUser.mockReturnValue(USER);
    mockSetReadState.mockResolvedValue("2026-04-29T10:00:00.000Z");

    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({
          chat_id: "c1",
          last_read_at: "2026-04-29T10:00:00.000Z",
          kind: "chat",
        }),
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, last_read_at: "2026-04-29T10:00:00.000Z" });
    expect(mockSetReadState).toHaveBeenCalledWith(
      "u1",
      "c1",
      "2026-04-29T10:00:00.000Z",
      { kind: "chat", userRole: "dev" },
    );
  });

  it("200 channel kind passthrough", async () => {
    mockGetUser.mockReturnValue(USER);
    mockSetReadState.mockResolvedValue("2026-04-29T10:00:00.000Z");
    const { POST } = await import("@/app/api/messages/read-state/route");
    await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({
          chat_id: "ch1",
          last_read_at: "2026-04-29T10:00:00.000Z",
          kind: "channel",
        }),
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(mockSetReadState).toHaveBeenCalledWith(
      "u1",
      "ch1",
      "2026-04-29T10:00:00.000Z",
      { kind: "channel", userRole: "dev" },
    );
  });

  it("500 when setReadState throws WriteQueryError", async () => {
    mockGetUser.mockReturnValue(USER);
    mockSetReadState.mockRejectedValue(new WriteQueryError("oops", "db_error"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/messages/read-state/route");
    const res = await POST(
      mkReq("/api/messages/read-state", {
        method: "POST",
        body: JSON.stringify({
          chat_id: "c1",
          last_read_at: "2026-04-29T10:00:00.000Z",
        }),
        headers: { authorization: "Bearer x", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
