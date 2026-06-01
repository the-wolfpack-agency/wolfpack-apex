/**
 * API: GET /api/usage.
 *
 * Covers:
 *   - 401 without auth.
 *   - Counts ai_calls + cache_hits from instinct_messages (the
 *     Wolfpack Assistant path). Regression for 2026-06-01: the
 *     route previously only counted these from instinct_events,
 *     so the Settings card read "10,605 tokens • 0 AI calls"
 *     while the assistant was clearly being used.
 *   - Counts ai_calls + cache_hits from instinct_events (the
 *     Support /api/knowledge/ask path).
 *   - Both stores contribute to a single total, not double-counted.
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

function mkReq(auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://test/api/usage", { method: "GET", headers }) as any;
}

const USER = { id: "u-test", email: "a@x.com", role: "dev" };

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test/test";
});

afterAll(() => {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

describe("GET /api/usage", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/usage/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
  });

  it("counts ai_calls + cache_hits from instinct_messages (assistant path) — regression 2026-06-01", async () => {
    /* The Settings card showed "10,605 tokens • 0 AI calls" because
       the route counted ai_calls only from instinct_events.  The
       assistant writes to instinct_messages with source='ai' /
       source='knowledge_cache'; both must now be reflected. */
    mockGetUser.mockReturnValue(USER);

    // Both windows (lifetime + 30d) call the same two queries in order.
    // First query: instinct_messages aggregate. Second: instinct_events.
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM instinct_messages")) {
        return {
          rows: [
            { total: "10605", ai_calls: "42", cache_hits: "97" },
          ],
        };
      }
      if (sql.includes("FROM instinct_events")) {
        return {
          rows: [
            {
              prompt: "0",
              completion: "0",
              ai_calls: "0",
              cache_hits: "0",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { GET } = await import("@/app/api/usage/route");
    const res = await GET(mkReq("Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Both lifetime and 30d should reflect the assistant counts.
    expect(body.lifetime.total_tokens).toBe(10605);
    expect(body.lifetime.ai_calls).toBe(42);
    expect(body.lifetime.cache_hits).toBe(97);

    expect(body.last_30_days.ai_calls).toBe(42);
    expect(body.last_30_days.cache_hits).toBe(97);
  });

  it("sums ai_calls + cache_hits across BOTH stores (instinct_messages + instinct_events)", async () => {
    mockGetUser.mockReturnValue(USER);

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM instinct_messages")) {
        return {
          rows: [{ total: "5000", ai_calls: "10", cache_hits: "20" }],
        };
      }
      if (sql.includes("FROM instinct_events")) {
        return {
          rows: [
            {
              prompt: "1000",
              completion: "500",
              ai_calls: "3",
              cache_hits: "7",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { GET } = await import("@/app/api/usage/route");
    const res = await GET(mkReq("Bearer t"));
    const body = await res.json();
    expect(body.lifetime.total_tokens).toBe(5000 + 1000 + 500);
    expect(body.lifetime.ai_calls).toBe(10 + 3);
    expect(body.lifetime.cache_hits).toBe(20 + 7);
  });

  it("returns zeroes when DATABASE_URL is not set (shadow / preview)", async () => {
    delete process.env.DATABASE_URL;
    mockGetUser.mockReturnValue(USER);
    const { GET } = await import("@/app/api/usage/route");
    const res = await GET(mkReq("Bearer t"));
    const body = await res.json();
    expect(body.lifetime).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      ai_calls: 0,
      cache_hits: 0,
    });
  });

  it("survives a missing table (shadow mode) without throwing", async () => {
    mockGetUser.mockReturnValue(USER);
    mockQuery.mockRejectedValue(new Error("relation does not exist"));
    const { GET } = await import("@/app/api/usage/route");
    const res = await GET(mkReq("Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lifetime.total_tokens).toBe(0);
    expect(body.lifetime.ai_calls).toBe(0);
    expect(body.lifetime.cache_hits).toBe(0);
  });
});
