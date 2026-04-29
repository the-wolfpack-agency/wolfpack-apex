/**
 * Contract tests for GET /api/insights/quick-actions.
 *
 * Asserts:
 *   - 401 when no Authorization header
 *   - 200 + fallback shape when the user has zero history
 *   - 200 + personalized shape when the user has rich history
 *   - DB unreachable (safeQuery.fromCache=true) → 200 + fallback
 *   - Always returns exactly 4 items
 */

const mockGetUserFromRequest = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUserFromRequest(...a),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/insights/quick-actions/route";
import {
  ACTION_COUNT,
  FALLBACK_ACTIONS,
} from "@/lib/insights/quick-actions";

function makeReq(authHeader?: string): NextRequest {
  return new NextRequest("http://test/api/insights/quick-actions", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/insights/quick-actions — auth", () => {
  test("401 when getUserFromRequest returns null", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    // Must not even reach the DB layer.
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("GET /api/insights/quick-actions — cold-start", () => {
  test("user with zero events → 200 + 4 fallback tiles", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({
      id: "u-1",
      email: "x@t",
      name: "X",
      role: "dev",
      created_at: "",
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const res = await GET(makeReq("Bearer fake.jwt.token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions).toHaveLength(ACTION_COUNT);
    expect(body.actions.every((a: { source: string }) => a.source === "fallback")).toBe(true);
    expect(body.actions.map((a: { href: string }) => a.href)).toEqual(
      FALLBACK_ACTIONS.map((a) => a.href),
    );
  });

  test("DB unreachable (fromCache=true) → 200 + fallback", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({
      id: "u-1",
      email: "x@t",
      name: "X",
      role: "dev",
      created_at: "",
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });

    const res = await GET(makeReq("Bearer fake.jwt.token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toHaveLength(ACTION_COUNT);
    expect(body.actions.every((a: { source: string }) => a.source === "fallback")).toBe(true);
  });
});

describe("GET /api/insights/quick-actions — personalized path", () => {
  test("user with rich history → 200 + 4 personalized tiles", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({
      id: "u-1",
      email: "x@t",
      name: "X",
      role: "dev",
      created_at: "",
    });

    const now = new Date();
    const fresh = (offsetMs: number) =>
      new Date(now.getTime() - offsetMs).toISOString();

    // Ten fresh hits each on three pages → all three score well above MIN_SCORE.
    const rows = [
      ...Array.from({ length: 10 }, () => ({ page: "/messages", ts: fresh(0) })),
      ...Array.from({ length: 10 }, () => ({ page: "/calendar", ts: fresh(0) })),
      ...Array.from({ length: 10 }, () => ({ page: "/emails", ts: fresh(0) })),
      ...Array.from({ length: 10 }, () => ({ page: "/tasks", ts: fresh(0) })),
    ];
    mockSafeQuery.mockResolvedValueOnce({ rows, fromCache: false });

    const res = await GET(makeReq("Bearer fake.jwt.token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toHaveLength(ACTION_COUNT);
    expect(body.actions.every((a: { source: string }) => a.source === "personalized")).toBe(true);

    // Exactly the four routes we fed in, in some order.
    expect(new Set(body.actions.map((a: { href: string }) => a.href))).toEqual(
      new Set(["/messages", "/calendar", "/emails", "/tasks"]),
    );

    // Each item exposes the documented contract fields.
    for (const a of body.actions) {
      expect(typeof a.label).toBe("string");
      expect(a.label.length).toBeGreaterThan(0);
      expect(typeof a.href).toBe("string");
      expect(a.href.startsWith("/")).toBe(true);
      expect(typeof a.score).toBe("number");
      expect(a.score).toBeGreaterThan(0);
      expect(["personalized", "fallback"]).toContain(a.source);
    }
  });

  test("rows with null page metadata are dropped before ranking", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({
      id: "u-1",
      email: "x@t",
      name: "X",
      role: "dev",
      created_at: "",
    });
    const now = new Date().toISOString();
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { page: null, ts: now },
        { page: "/messages", ts: now },
        { page: "/messages", ts: now },
        { page: "/messages", ts: now },
      ],
      fromCache: false,
    });

    const res = await GET(makeReq("Bearer fake.jwt.token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only one strong route → fallback path.
    expect(body.actions.every((a: { source: string }) => a.source === "fallback")).toBe(true);
  });
});

describe("GET /api/insights/quick-actions — DB query shape", () => {
  test("queries instinct_events filtered by user + 30-day window", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({
      id: "u-42",
      email: "x@t",
      name: "X",
      role: "dev",
      created_at: "",
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    await GET(makeReq("Bearer fake.jwt.token"));
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(typeof sql).toBe("string");
    expect(sql).toMatch(/system\.page_viewed/);
    expect(sql).toMatch(/instinct_events/);
    expect(sql).toMatch(/30 days/);
    expect(params).toEqual(["u-42"]);
  });
});
