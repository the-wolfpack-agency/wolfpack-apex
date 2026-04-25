/**
 * analyses-repo unit tests — Phase 4/5 graceful tolerance for the
 * Phase 2/3 analyses table not existing yet.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import { getAnalysesByMessageIds } from "../analyses-repo";

beforeEach(() => jest.clearAllMocks());

describe("getAnalysesByMessageIds", () => {
  it("returns empty map for empty input (no DB hit)", async () => {
    const out = await getAnalysesByMessageIds([]);
    expect(out.size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("maps rows back to records", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "a1",
          message_id: "m1",
          summary: "Pricing decisions",
          decisions: [{ description: "Ship v1" }],
          action_items: [{ description: "Ship", assignee: "alice" }],
          topics: [{ topic: "pricing" }],
          attendees: [],
          blockers: [],
          next_steps: [],
          created_at: "2026-04-15T00:00:00Z",
        },
      ],
    });
    const out = await getAnalysesByMessageIds(["m1"]);
    expect(out.get("m1")?.summary).toBe("Pricing decisions");
    expect(out.get("m1")?.topics[0].topic).toBe("pricing");
  });

  it("returns empty map when the table doesn't exist (42P01)", async () => {
    const err: Error & { code?: string } = new Error("relation does not exist");
    err.code = "42P01";
    mockQuery.mockRejectedValueOnce(err);
    const out = await getAnalysesByMessageIds(["m1"]);
    expect(out.size).toBe(0);
  });

  it("propagates other DB errors", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    await expect(getAnalysesByMessageIds(["m1"])).rejects.toThrow();
  });

  it("coerces null arrays to []", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "a1",
          message_id: "m1",
          summary: null,
          decisions: null,
          action_items: null,
          topics: null,
          attendees: null,
          blockers: null,
          next_steps: null,
          created_at: "2026-04-15T00:00:00Z",
        },
      ],
    });
    const out = await getAnalysesByMessageIds(["m1"]);
    const rec = out.get("m1");
    expect(rec?.decisions).toEqual([]);
    expect(rec?.action_items).toEqual([]);
    expect(rec?.topics).toEqual([]);
  });
});
