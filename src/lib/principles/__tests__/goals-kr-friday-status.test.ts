const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { evaluateGoalsKrFridayStatus } from "@/lib/principles/evaluators/goals-kr-friday-status";

beforeEach(() => {
  mockSafeQuery.mockReset();
});

const ctx = {
  windowStart: "2026-04-25T00:00:00Z",
  windowEnd: "2026-05-02T00:00:00Z",
  subjectUserId: "u1",
};

describe("evaluateGoalsKrFridayStatus (team-wide)", () => {
  test("no active KRs → []", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await evaluateGoalsKrFridayStatus(ctx)).toEqual([]);
  });

  test("KRs without contributions in window → drift score per KR", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          { kr_id: "k1", kr_metric: "ARR", okr_id: "o1", okr_objective: "Grow ARR" },
          { kr_id: "k2", kr_metric: "NPS", okr_id: "o1", okr_objective: "Grow ARR" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const obs = await evaluateGoalsKrFridayStatus(ctx);
    expect(obs).toHaveLength(2);
    expect(obs[0].score).toBe(-0.4);
    expect(obs[0].surface).toBe("goals");
    expect(obs[0].surfaceSubtype).toBe("kr_friday_status");
    expect(obs[0].evidence.metric).toEqual({ name: "contrib_count", value: 0 });
    expect(obs[0].evidence.notes).toContain("no updates");
  });

  test("KRs with contributions in window → adherence score", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ kr_id: "k1", kr_metric: "ARR", okr_id: "o1", okr_objective: "Grow ARR" }],
      })
      .mockResolvedValueOnce({
        rows: [{ kr_id: "k1", contrib_count: "3", last_at: "2026-04-30T10:00:00Z" }],
      });
    const obs = await evaluateGoalsKrFridayStatus(ctx);
    expect(obs[0].score).toBe(0.4);
    expect(obs[0].evidence.metric).toEqual({ name: "contrib_count", value: 3 });
    expect(obs[0].evidence.notes).toContain("3 update");
  });

  test("safeQuery throws on KRs lookup → []", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await evaluateGoalsKrFridayStatus(ctx)).toEqual([]);
  });
});
