/**
 * API: GET + POST /api/ms/presence.
 */
 

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

const mockGetPresence = jest.fn();
const mockGetOwnPresence = jest.fn();
jest.mock("@/lib/ms-graph-presence", () => ({
  getPresence: (...a: any[]) => mockGetPresence(...a),
  getOwnPresence: (...a: any[]) => mockGetOwnPresence(...a),
}));

const fetchMock = jest.fn();
beforeAll(() => {
  (global as any).fetch = fetchMock;
});

function mkReq(path: string, method = "GET", auth?: string, body?: any): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  if (body !== undefined) headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://test${path}`, init) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
});

describe("GET /api/ms/presence", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/presence/route");
    const res = await GET(mkReq("/api/ms/presence"));
    expect(res.status).toBe(401);
  });

  it("200 presence when connected", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockGetOwnPresence.mockResolvedValue({
      userId: "u",
      availability: "Available",
      activity: "Available",
    });
    const { GET } = await import("@/app/api/ms/presence/route");
    const res = await GET(mkReq("/api/ms/presence", "GET", "Bearer tok"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presence.availability).toBe("Available");
  });

  it("200 { connected: false } when no MS token", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue(null);
    const { GET } = await import("@/app/api/ms/presence/route");
    const res = await GET(mkReq("/api/ms/presence", "GET", "Bearer tok"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });
});

describe("POST /api/ms/presence", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/ms/presence/route");
    const res = await POST(
      mkReq("/api/ms/presence", "POST", undefined, { user_ids: [] }),
    );
    expect(res.status).toBe(401);
  });

  it("200 empty presences when user_ids is empty", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { POST } = await import("@/app/api/ms/presence/route");
    const res = await POST(
      mkReq("/api/ms/presence", "POST", "Bearer tok", { user_ids: [] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presences).toEqual([]);
  });

  it("200 { connected: false } when no MS token", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue(null);
    const { POST } = await import("@/app/api/ms/presence/route");
    const res = await POST(
      mkReq("/api/ms/presence", "POST", "Bearer tok", { user_ids: ["x"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it("200 presences on happy path", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockGetPresence.mockResolvedValue(
      new Map([
        ["u1", { userId: "u1", availability: "Available", activity: "Available" }],
        ["u2", { userId: "u2", availability: "Busy", activity: "InAMeeting" }],
      ]),
    );
    const { POST } = await import("@/app/api/ms/presence/route");
    const res = await POST(
      mkReq("/api/ms/presence", "POST", "Bearer tok", { user_ids: ["u1", "u2"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presences).toHaveLength(2);
  });

  it("200 { scope_missing: true } when lib returns empty + /me/presence 401s", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockGetPresence.mockResolvedValue(new Map());
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "",
    });
    const { POST } = await import("@/app/api/ms/presence/route");
    const res = await POST(
      mkReq("/api/ms/presence", "POST", "Bearer tok", { user_ids: ["u1"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
  });

  it("500 when an unexpected error bubbles", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockGetPresence.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/ms/presence/route");
    const res = await POST(
      mkReq("/api/ms/presence", "POST", "Bearer tok", { user_ids: ["x"] }),
    );
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
