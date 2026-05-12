 
const mockGetActiveOKRs = jest.fn();
const mockGetNorthStarTrend = jest.fn();

jest.mock("@/lib/goals", () => ({
  getActiveOKRs: (...a: any[]) => mockGetActiveOKRs(...a),
}));
jest.mock("@/lib/goals-north-star", () => ({
  getNorthStarTrend: (...a: any[]) => mockGetNorthStarTrend(...a),
}));

import { runGoalsLookup } from "@/lib/assistant/tools/goals-lookup";

beforeEach(() => {
  mockGetActiveOKRs.mockReset();
  mockGetNorthStarTrend.mockReset();
});

describe("runGoalsLookup", () => {
  test("returns null when both sides are empty", async () => {
    mockGetActiveOKRs.mockResolvedValue([]);
    mockGetNorthStarTrend.mockResolvedValue({ latest: null, history: [] });
    expect(await runGoalsLookup()).toBeNull();
  });

  test("formats OKRs + North Star when both are present", async () => {
    mockGetActiveOKRs.mockResolvedValue([
      {
        id: "o1",
        quarter: "2026-Q2",
        objective: "Launch MVP",
        krs: [{ metric: "signups", current_value: 10, target_value: 100, unit: "users" }],
      },
    ]);
    mockGetNorthStarTrend.mockResolvedValue({
      latest: { id: "s1", label: "MRR", value: 1_000_000_000, unit: "USD" },
      history: [],
    });
    const out = await runGoalsLookup();
    expect(out?.northStar?.label).toBe("MRR");
    expect(out?.okrs).toHaveLength(1);
    expect(out?.answer).toContain("Launch MVP");
    expect(out?.answer).toContain("MRR");
  });

  test("tolerates lib failures by returning null", async () => {
    mockGetActiveOKRs.mockRejectedValue(new Error("pg down"));
    mockGetNorthStarTrend.mockResolvedValue({ latest: null, history: [] });
    expect(await runGoalsLookup()).toBeNull();
  });
});
