const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

import {
  evaluateTasksWeeklyFinishRate,
  scoreForFinishRate,
} from "@/lib/principles/evaluators/tasks-weekly-finish-rate";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("scoreForFinishRate", () => {
  test("no starts → neutral, no_starts tier", () => {
    const r = scoreForFinishRate(0, 0);
    expect(r.score).toBe(0);
    expect(r.tier).toBe("no_starts");
  });
  test("100% finish → strong (+0.6)", () => {
    expect(scoreForFinishRate(5, 5)).toEqual({ score: 0.6, tier: "strong", ratio: 1 });
  });
  test("70% finish → good (+0.3)", () => {
    const r = scoreForFinishRate(10, 7);
    expect(r.score).toBe(0.3);
    expect(r.tier).toBe("good");
  });
  test("50% finish → neutral (0)", () => {
    expect(scoreForFinishRate(10, 5)).toMatchObject({ score: 0, tier: "neutral" });
  });
  test("30% finish → weak (-0.3)", () => {
    expect(scoreForFinishRate(10, 3)).toMatchObject({ score: -0.3, tier: "weak" });
  });
  test("10% finish → drift (-0.6)", () => {
    expect(scoreForFinishRate(10, 1)).toMatchObject({ score: -0.6, tier: "drift" });
  });
});

describe("evaluateTasksWeeklyFinishRate", () => {
  const ctx = {
    windowStart: "2026-04-25T00:00:00Z",
    windowEnd: "2026-05-02T00:00:00Z",
    subjectUserId: "u1",
  };

  test("no token → []", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    expect(await evaluateTasksWeeklyFinishRate(ctx)).toEqual([]);
  });

  test("counts started + finished, emits one observation", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "t", userEmail: "x" });
    const lists = {
      ok: true,
      status: 200,
      json: async () => ({ value: [{ id: "L1" }] }),
    };
    /* 4 started in window, 3 completed → 75% → good */
    const tasks = {
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          { id: "t1", status: "completed" },
          { id: "t2", status: "completed" },
          { id: "t3", status: "completed" },
          { id: "t4", status: "inProgress" },
        ],
      }),
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(lists)
      .mockResolvedValueOnce(tasks) as unknown as typeof fetch;

    const obs = await evaluateTasksWeeklyFinishRate(ctx);
    expect(obs).toHaveLength(1);
    expect(obs[0].surfaceSubtype).toBe("weekly_finish_rate");
    expect(obs[0].score).toBe(0.3);
    expect(obs[0].evidence.metric).toEqual({ name: "finish_pct", value: 75 });
    expect(obs[0].evidence.notes).toContain("3/4");
    expect(obs[0].evidence.notes).toContain("good");
  });

  test("no tasks started in window → score 0 + zero-volume notes", async () => {
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
    const obs = await evaluateTasksWeeklyFinishRate(ctx);
    expect(obs[0].score).toBe(0);
    expect(obs[0].evidence.notes).toContain("nothing to assess");
  });
});
