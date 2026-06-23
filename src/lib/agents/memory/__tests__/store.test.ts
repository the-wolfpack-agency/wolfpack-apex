/**
 * Memory store: a safe procedure is promoted (inheritable), an unsafe one is
 * rejected, inheritance returns a promoted plan and counts the hit, and goal
 * keys normalize across phrasing.
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

// Control the safety verdict directly so this test is about the store, not the
// policy (which has its own test).
const mockVerify = jest.fn();
jest.mock("@/lib/agents/memory/promote", () => ({
  verifyProcedureForPromotion: (...a: unknown[]) => mockVerify(...a),
}));

import {
  recordLearnedProcedure,
  findPromotedProcedure,
  normalizeGoalKey,
} from "@/lib/agents/memory/store";

beforeEach(() => {
  mockQuery.mockReset();
  mockWriteQuery.mockReset();
  mockSafeQuery.mockReset();
  mockTrackEvent.mockReset();
  mockVerify.mockReset();
  mockWriteQuery.mockResolvedValue({ rows: [] });
});

describe("normalizeGoalKey", () => {
  it("is stable across whitespace and case", () => {
    expect(normalizeGoalKey("Get  the   Weather")).toBe(normalizeGoalKey("get the weather"));
    expect(normalizeGoalKey("a")).not.toBe(normalizeGoalKey("b"));
  });
});

describe("recordLearnedProcedure", () => {
  it("promotes when the safety check passes", async () => {
    mockVerify.mockReturnValue({ safe: true, reason: null });
    const out = await recordLearnedProcedure({
      workspaceId: "ws", goal: "get weather", plan: [{ instruction: "weather", tool: "weather" }],
      learnedByAgent: "a1", sourceTaskId: "t1",
    });
    expect(out.status).toBe("promoted");
    // Stored with status promoted.
    expect(mockWriteQuery.mock.calls[0][1]).toContain("promoted");
    expect(mockTrackEvent).toHaveBeenCalledWith("agent.procedure_promoted", "a1", "agent", expect.any(Object));
  });

  it("rejects (quarantines) when a step would be blocked", async () => {
    mockVerify.mockReturnValue({ safe: false, reason: "delete_records is escalate" });
    const out = await recordLearnedProcedure({
      workspaceId: "ws", goal: "delete stuff", plan: [{ instruction: "delete", tool: "delete_records" }],
      learnedByAgent: "a1", sourceTaskId: "t1",
    });
    expect(out.status).toBe("rejected");
    expect(mockTrackEvent).toHaveBeenCalledWith("agent.procedure_rejected", "a1", "agent", expect.objectContaining({ reason: expect.any(String) }));
  });
});

describe("findPromotedProcedure (inheritance)", () => {
  it("returns a promoted procedure, counts the hit, and emits inherited", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: "m1", workspace_id: "ws", goal_key: "k", goal: "get weather", plan: [{ instruction: "weather", tool: "weather" }], status: "promoted", learned_by_agent: "a1", source_task_id: "t1", hit_count: 2, reject_reason: null, created_at: "t", verified_at: "t" }] })
      .mockResolvedValueOnce({ rows: [] }); // the hit-count update
    const entry = await findPromotedProcedure("ws", "get weather", "a2");
    expect(entry?.id).toBe("m1");
    expect(entry?.learnedByAgent).toBe("a1");
    // The reusing agent (a2) is credited with inheriting a1's procedure.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.procedure_inherited", "a2", "agent",
      expect.objectContaining({ learned_by_agent: "a1" }),
    );
  });

  it("returns null when nothing is promoted for the goal", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await findPromotedProcedure("ws", "novel goal", "a2")).toBeNull();
  });
});
