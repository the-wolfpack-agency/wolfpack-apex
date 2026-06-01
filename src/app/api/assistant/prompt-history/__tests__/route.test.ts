/**
 * API: GET /api/assistant/prompt-history.
 *
 * Covers:
 *   - 401 without auth.
 *   - Empty list when DATABASE_URL is not set (shadow / preview).
 *   - Happy path: returns deduped + truncated prompts.
 *   - Default + max limit clamping.
 *   - Graceful empty list when the table is missing.
 */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: any[]) => mockQuery(...a),
}));

function mkReq(path = "/api/assistant/prompt-history", auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

const USER = { id: "u-1", email: "a@x.com", role: "dev" };
const ORIGINAL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe("GET /api/assistant/prompt-history", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/assistant/prompt-history/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns { prompts: [] } when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    mockGetUser.mockReturnValue(USER);
    const { GET } = await import("@/app/api/assistant/prompt-history/route");
    const res = await GET(mkReq("/api/assistant/prompt-history", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ prompts: [] });
    /* The route should never reach the DB when the env var is missing. */
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns prompts in newest-first order with ask_count + ISO timestamp", async () => {
    mockGetUser.mockReturnValue(USER);
    mockQuery.mockResolvedValue({
      rows: [
        {
          content: "give me insights",
          last_asked_at: "2026-05-30T10:00:00Z",
          ask_count: 3,
        },
        {
          content: "what's on my calendar",
          last_asked_at: "2026-05-28T09:00:00Z",
          ask_count: 1,
        },
      ],
    });

    const { GET } = await import("@/app/api/assistant/prompt-history/route");
    const res = await GET(mkReq("/api/assistant/prompt-history", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompts).toHaveLength(2);
    expect(body.prompts[0]).toMatchObject({
      content: "give me insights",
      ask_count: 3,
    });
    expect(body.prompts[0].last_asked_at).toBe("2026-05-30T10:00:00.000Z");
    expect(body.prompts[1].content).toBe("what's on my calendar");
  });

  it("truncates long prompts with an ellipsis (overlay shows a one-liner)", async () => {
    mockGetUser.mockReturnValue(USER);
    const long = "a".repeat(500);
    mockQuery.mockResolvedValue({
      rows: [
        { content: long, last_asked_at: new Date().toISOString(), ask_count: 1 },
      ],
    });
    const { GET } = await import("@/app/api/assistant/prompt-history/route");
    const res = await GET(mkReq("/api/assistant/prompt-history", "Bearer t"));
    const body = await res.json();
    expect(body.prompts[0].content.endsWith("…")).toBe(true);
    expect(body.prompts[0].content.length).toBeLessThan(long.length);
  });

  it("defaults limit to 20 and clamps to 50 max", async () => {
    mockGetUser.mockReturnValue(USER);
    mockQuery.mockResolvedValue({ rows: [] });

    const { GET } = await import("@/app/api/assistant/prompt-history/route");

    await GET(mkReq("/api/assistant/prompt-history", "Bearer t"));
    expect(mockQuery.mock.calls[0][1][2]).toBe(20);

    await GET(
      mkReq("/api/assistant/prompt-history?limit=999", "Bearer t"),
    );
    expect(mockQuery.mock.calls[1][1][2]).toBe(50);

    await GET(
      mkReq("/api/assistant/prompt-history?limit=garbage", "Bearer t"),
    );
    expect(mockQuery.mock.calls[2][1][2]).toBe(20);
  });

  it("returns empty list (200) when the table is missing — never blocks the UI", async () => {
    mockGetUser.mockReturnValue(USER);
    mockQuery.mockRejectedValue(new Error('relation "instinct_messages" does not exist'));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await import("@/app/api/assistant/prompt-history/route");
    const res = await GET(mkReq("/api/assistant/prompt-history", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ prompts: [] });
    warn.mockRestore();
  });
});
