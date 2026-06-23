/**
 * Contract tests for /api/briefing.
 *
 * Covers auth (401), happy path (200), and the timezone threading that fixes
 * the combining-days bug: ?tz= must be read and forwarded to generateBriefing.
 */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const mockGenerate = jest.fn();
jest.mock("@/lib/morning-briefing", () => ({
  generateBriefing: (...a: any[]) => mockGenerate(...a),
}));

const USER = { id: "tm_x", name: "Nick Homyk", role: "ceo" };

function mkReq(url: string, auth: string | null = "Bearer t"): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return { url, headers };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue(USER);
  mockGenerate.mockResolvedValue({ greeting: "Good morning", calendar: { events: [] } });
});

describe("GET /api/briefing", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const { GET } = await import("@/app/api/briefing/route");
    const res = await GET(mkReq("https://app/api/briefing", null));
    expect(res.status).toBe(401);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("200 happy path", async () => {
    const { GET } = await import("@/app/api/briefing/route");
    const res = await GET(mkReq("https://app/api/briefing"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.greeting).toBe("Good morning");
  });

  it("reads ?tz= and forwards it to generateBriefing as timeZone", async () => {
    const { GET } = await import("@/app/api/briefing/route");
    await GET(mkReq("https://app/api/briefing?tz=America%2FNew_York"));
    expect(mockGenerate).toHaveBeenCalledWith(
      USER.id,
      USER.role,
      expect.objectContaining({ timeZone: "America/New_York" }),
    );
  });

  it("forwards both refresh and tz when present", async () => {
    const { GET } = await import("@/app/api/briefing/route");
    await GET(mkReq("https://app/api/briefing?refresh=true&tz=Europe%2FParis"));
    expect(mockGenerate).toHaveBeenCalledWith(
      USER.id,
      USER.role,
      expect.objectContaining({ force: true, timeZone: "Europe/Paris" }),
    );
  });

  it("passes timeZone undefined when tz is absent (lib applies the default)", async () => {
    const { GET } = await import("@/app/api/briefing/route");
    await GET(mkReq("https://app/api/briefing"));
    expect(mockGenerate).toHaveBeenCalledWith(
      USER.id,
      USER.role,
      expect.objectContaining({ timeZone: undefined }),
    );
  });

  it("rejects an absurdly long tz string (treated as absent)", async () => {
    const { GET } = await import("@/app/api/briefing/route");
    const longTz = "A".repeat(200);
    await GET(mkReq(`https://app/api/briefing?tz=${longTz}`));
    expect(mockGenerate).toHaveBeenCalledWith(
      USER.id,
      USER.role,
      expect.objectContaining({ timeZone: undefined }),
    );
  });
});
