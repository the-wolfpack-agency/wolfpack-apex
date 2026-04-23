/**
 * API: GET /api/ms/deep-links.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/ms/deep-links", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(mkReq("/api/ms/deep-links?type=chat&email=a@x.com"));
    expect(res.status).toBe(401);
  });

  it("400 on missing type", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(mkReq("/api/ms/deep-links", "Bearer t"));
    expect(res.status).toBe(400);
  });

  it("400 on invalid type", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(mkReq("/api/ms/deep-links?type=whoops", "Bearer t"));
    expect(res.status).toBe(400);
  });

  it("400 when type=chat but email missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(mkReq("/api/ms/deep-links?type=chat", "Bearer t"));
    expect(res.status).toBe(400);
  });

  it("400 when type=call but email invalid", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(
      mkReq("/api/ms/deep-links?type=call&email=not-email", "Bearer t"),
    );
    expect(res.status).toBe(400);
  });

  it("200 chat deep-link with message fires analytics", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(
      mkReq("/api/ms/deep-links?type=chat&email=bob%40x.com&message=hi", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("chat");
    expect(body.url).toContain("teams.microsoft.com/l/chat/0/0");
    expect(body.url).toContain("bob%40x.com");
    expect(body.url).toContain("message=hi");
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_deep_link.generated",
      "u",
      "dev",
      { type: "chat" },
    );
  });

  it("200 call deep-link with withVideo=1", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(
      mkReq("/api/ms/deep-links?type=call&email=bob%40x.com&with_video=1", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("/l/call/0/0");
    expect(body.url).toContain("withVideo=1");
  });

  it("200 meet_now deep-link", async () => {
    mockGetUser.mockReturnValue({ id: "u", email: "a@x.com", role: "dev" });
    const { GET } = await import("@/app/api/ms/deep-links/route");
    const res = await GET(mkReq("/api/ms/deep-links?type=meet_now", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("meet_now");
    expect(body.url).toBe("https://teams.microsoft.com/l/meeting/new");
  });
});
