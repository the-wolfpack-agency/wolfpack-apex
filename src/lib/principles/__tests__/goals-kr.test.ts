/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
  };
});

import { evaluateGoalsKrMeasurability } from "@/lib/principles/evaluators/goals-kr-measurability";

beforeEach(() => mockSafeQuery.mockReset());

describe("evaluateGoalsKrMeasurability", () => {
  test("returns [] without subjectUserId", async () => {
    const out = await evaluateGoalsKrMeasurability({
      windowStart: "x",
      windowEnd: "y",
    });
    expect(out).toEqual([]);
  });
  test("OKR with at least one numeric KR scores +0.5; without → -0.5", async () => {
    /* First query: OKRs. Second query: KRs. */
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          { id: "o1", title: "Ship faster", status: "active" },
          { id: "o2", title: "Vague aspiration", status: "in_progress" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ okr_id: "o1", target_value: "100" }],
      });
    const out = await evaluateGoalsKrMeasurability({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(2);
    const o1 = out.find(
      (o) => (o.evidence as { sourceId?: string }).sourceId === "o1",
    );
    const o2 = out.find(
      (o) => (o.evidence as { sourceId?: string }).sourceId === "o2",
    );
    expect(o1?.score).toBe(0.5);
    expect(o2?.score).toBe(-0.5);
    expect(out.every((o) => o.subjectUserId === "u1")).toBe(true);
  });
  test("zero active OKRs returns []", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const out = await evaluateGoalsKrMeasurability({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
});
