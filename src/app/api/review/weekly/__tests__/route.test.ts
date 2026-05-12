/**
 * GET /api/review/weekly — auth gate, happy path, slip-analytics fanout.
 */
 

const mockGetUser = jest.fn();
const mockCompute = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: any[]) => mockGetUser(...args),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));
jest.mock("@/lib/review/weekly", () => {
  const DAY = 24 * 60 * 60 * 1000;
  return {
    computeWeeklyReview: (...args: any[]) => mockCompute(...args),
    mondayOf: (d: Date) => {
      const dow = d.getUTCDay();
      const off = (dow + 6) % 7;
      const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off * DAY;
      return new Date(ms);
    },
  };
});

import { NextRequest } from "next/server";
import { GET } from "../route";

function mkReq(url: string, auth: string | null = "Bearer x"): NextRequest {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  return new NextRequest(url, { method: "GET", headers });
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockCompute.mockReset();
  mockTrack.mockReset();
});

describe("GET /api/review/weekly", () => {
  test("401 when no user", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(mkReq("http://test/api/review/weekly"));
    expect(res.status).toBe(401);
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test("200 happy path returns the computed shape", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x" });
    mockCompute.mockResolvedValue({
      weekStart: "2026-04-20T00:00:00.000Z",
      weekEnd: "2026-04-27T00:00:00.000Z",
      meetingsAttended: 3,
      tasksClosed: 5,
      tasksOpened: 2,
      unansweredFlagged: 1,
      slips: [],
    });

    const res = await GET(mkReq("http://test/api/review/weekly"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meetingsAttended).toBe(3);
    expect(body.weekStart).toBe("2026-04-20T00:00:00.000Z");
  });

  test("fires review.weekly_computed once and review.slip_detected once per slip", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x" });
    mockCompute.mockResolvedValue({
      weekStart: "2026-04-20T00:00:00.000Z",
      weekEnd: "2026-04-27T00:00:00.000Z",
      meetingsAttended: 0,
      tasksClosed: 0,
      tasksOpened: 0,
      unansweredFlagged: 0,
      slips: [
        { id: "s1", title: "A", reason: "overdue", dueAt: "2026-04-18T12:00:00Z" },
        { id: "s2", title: "B", reason: "carried_forward", dueAt: "2026-04-21T12:00:00Z" },
      ],
    });

    const res = await GET(mkReq("http://test/api/review/weekly"));
    expect(res.status).toBe(200);

    const events = mockTrack.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === "review.weekly_computed")).toHaveLength(1);
    expect(events.filter((e) => e === "review.slip_detected")).toHaveLength(2);

    const computed = mockTrack.mock.calls.find((c) => c[0] === "review.weekly_computed")!;
    expect(computed[1]).toBe("u1"); // user id (server-side, from auth)
    expect(computed[3].week_start).toBe("2026-04-20T00:00:00.000Z");
    expect(computed[3].slip_count).toBe(2);

    const slipCalls = mockTrack.mock.calls.filter((c) => c[0] === "review.slip_detected");
    expect(slipCalls.map((c) => c[3].task_id).sort()).toEqual(["s1", "s2"]);
    expect(slipCalls[0][3].week_start).toBe("2026-04-20T00:00:00.000Z");
  });

  test("accepts ?weekStart=YYYY-MM-DD and forwards the Monday of that week", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x" });
    mockCompute.mockResolvedValue({
      weekStart: "2026-04-20T00:00:00.000Z",
      weekEnd: "2026-04-27T00:00:00.000Z",
      meetingsAttended: 0,
      tasksClosed: 0,
      tasksOpened: 0,
      unansweredFlagged: 0,
      slips: [],
    });

    // Wednesday of that week → should snap to Monday 2026-04-20.
    await GET(mkReq("http://test/api/review/weekly?weekStart=2026-04-22"));
    expect(mockCompute).toHaveBeenCalledTimes(1);
    const [userId, weekStart] = mockCompute.mock.calls[0];
    expect(userId).toBe("u1");
    expect((weekStart as Date).toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });

  test("400 on invalid weekStart", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x" });
    const res = await GET(mkReq("http://test/api/review/weekly?weekStart=not-a-date"));
    expect(res.status).toBe(400);
    expect(mockCompute).not.toHaveBeenCalled();
  });
});
