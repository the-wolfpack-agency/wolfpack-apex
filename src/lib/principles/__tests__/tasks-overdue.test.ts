/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  isOverdue,
  evaluateTasksOverdue,
} from "@/lib/principles/evaluators/tasks-overdue";

const ORIG_FETCH = global.fetch;
beforeEach(() => mockGetValidToken.mockReset());
afterEach(() => {
  global.fetch = ORIG_FETCH;
});

describe("isOverdue", () => {
  test("completed → false even when past due", () => {
    expect(
      isOverdue(
        {
          status: "completed",
          dueDateTime: { dateTime: "2020-01-01T00:00:00Z" },
        },
        Date.now(),
      ),
    ).toBe(false);
  });
  test("no due date → false", () => {
    expect(isOverdue({ status: "notStarted" }, Date.now())).toBe(false);
  });
  test("past due + not completed → true", () => {
    expect(
      isOverdue(
        {
          status: "notStarted",
          dueDateTime: { dateTime: "2020-01-01T00:00:00Z" },
        },
        Date.now(),
      ),
    ).toBe(true);
  });
});

describe("evaluateTasksOverdue", () => {
  test("returns [] when no token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const out = await evaluateTasksOverdue({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
  test("emits one observation per overdue task across all lists", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith("/todo/lists")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [{ id: "list-1" }, { id: "list-2" }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "t-overdue",
              status: "notStarted",
              title: "Old task",
              dueDateTime: { dateTime: "2020-01-01T00:00:00Z" },
              webLink: "https://outlook/t/1",
            },
            {
              id: "t-future",
              status: "notStarted",
              dueDateTime: {
                dateTime: new Date(Date.now() + 86_400_000).toISOString(),
              },
            },
          ],
        }),
      };
    }) as any;
    const out = await evaluateTasksOverdue({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    /* 2 lists × 1 overdue task each = 2 observations. */
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.surface === "tasks")).toBe(true);
    expect(out.every((o) => o.score === -0.5)).toBe(true);
    expect(out[0].evidence.kind).toBe("todo_overdue");
  });
  test("graph 5xx on lists → []", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as any;
    const out = await evaluateTasksOverdue({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
});
