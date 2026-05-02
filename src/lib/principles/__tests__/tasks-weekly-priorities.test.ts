const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  evaluateTasksWeeklyPriorities,
  scoreForPriorityCount,
} from "@/lib/principles/evaluators/tasks-weekly-priorities";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("scoreForPriorityCount", () => {
  test.each([
    [0, 0.5],
    [1, 0.5],
    [2, 0.5],
    [3, 0.0],
    [4, -0.3],
    [5, -0.6],
    [6, -0.6],
    [7, -0.9],
    [12, -0.9],
  ])("count=%i → score=%f", (count, expected) => {
    expect(scoreForPriorityCount(count)).toBe(expected);
  });
});

describe("evaluateTasksWeeklyPriorities", () => {
  const ctx = {
    windowStart: "2026-04-25T00:00:00Z",
    windowEnd: "2026-05-02T00:00:00Z",
    subjectUserId: "u1",
  };

  test("no token → []", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    expect(await evaluateTasksWeeklyPriorities(ctx)).toEqual([]);
  });

  test("no subjectUserId → []", async () => {
    expect(
      await evaluateTasksWeeklyPriorities({
        windowStart: ctx.windowStart,
        windowEnd: ctx.windowEnd,
      }),
    ).toEqual([]);
  });

  test("graph 5xx on lists → []", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response) as unknown as typeof fetch;
    expect(await evaluateTasksWeeklyPriorities(ctx)).toEqual([]);
  });

  test("counts high-importance active tasks across lists, scores correctly", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const lists = { ok: true, status: 200, json: async () => ({ value: [{ id: "L1" }, { id: "L2" }] }) };
    const tasksL1 = {
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          { id: "t1", title: "Ship principle 7", importance: "high", status: "inProgress" },
          { id: "t2", title: "Ship principle 3", importance: "high", status: "notStarted" },
        ],
      }),
    };
    const tasksL2 = {
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          { id: "t3", title: "Write tests", importance: "high", status: "waitingOnOthers" },
          { id: "t4", title: "Polish docs", importance: "high", status: "deferred" },
        ],
      }),
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(lists)
      .mockResolvedValueOnce(tasksL1)
      .mockResolvedValueOnce(tasksL2) as unknown as typeof fetch;

    const obs = await evaluateTasksWeeklyPriorities(ctx);
    expect(obs).toHaveLength(1);
    expect(obs[0].surface).toBe("tasks");
    expect(obs[0].surfaceSubtype).toBe("weekly_priority_count");
    /* 4 priorities → -0.3 */
    expect(obs[0].score).toBe(-0.3);
    expect(obs[0].evidence.metric).toEqual({ name: "priority_count", value: 4 });
    expect(obs[0].evidence.notes).toContain("4 high-importance active tasks");
    expect(obs[0].evidence.notes).toContain("Ship principle 7");
  });

  test("zero priorities → adherence + zero-count notes", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ value: [{ id: "L1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ value: [] }),
      }) as unknown as typeof fetch;
    const obs = await evaluateTasksWeeklyPriorities(ctx);
    expect(obs[0].score).toBe(0.5);
    expect(obs[0].evidence.metric).toEqual({ name: "priority_count", value: 0 });
  });
});
