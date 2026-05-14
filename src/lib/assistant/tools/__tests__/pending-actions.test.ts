/**
 * Tests for the Phase-3 pending-action confirmation flow.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import {
  detectConfirmationIntent,
  savePendingAction,
  consumeMostRecentPendingAction,
  cleanupExpiredPendingActions,
} from "@/lib/assistant/tools/pending-actions";

const ORIGINAL_DB = process.env.DATABASE_URL;

beforeEach(() => {
  mockSafeQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB;
});

describe("detectConfirmationIntent", () => {
  test.each([
    ["yes", "confirm"],
    ["YES", "confirm"],
    ["Yes please.", "confirm"],
    ["confirm", "confirm"],
    ["go ahead!", "confirm"],
    ["proceed", "confirm"],
    ["ok", "confirm"],
  ])("treats '%s' as %s", (msg, want) => {
    expect(detectConfirmationIntent(msg)).toBe(want);
  });

  test.each([
    ["cancel", "cancel"],
    ["No.", "cancel"],
    ["never mind", "cancel"],
    ["nope", "cancel"],
  ])("treats '%s' as cancel", (msg) => {
    expect(detectConfirmationIntent(msg)).toBe("cancel");
  });

  test.each([
    "yes please save the report and email Bob",
    "I'm not sure",
    "what does that mean",
    "yes that's the one",
    "",
  ])("does NOT confirm casual or compound message '%s'", (msg) => {
    expect(detectConfirmationIntent(msg)).toBe("none");
  });
});

describe("savePendingAction", () => {
  test("returns synthetic id in shadow mode", async () => {
    delete process.env.DATABASE_URL;
    const r = await savePendingAction({
      userId: "u1",
      toolName: "save_team_fact",
      params: { subject: "Acme", attribute: "owner", value: "Jorge" },
      description: "save the fact ...",
    });
    expect(r.id).toMatch(/^shadow-/);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("INSERTs the row and returns the new id", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "pa-123" }] });
    const r = await savePendingAction({
      userId: "u1",
      toolName: "save_team_fact",
      params: { subject: "Acme" },
      description: "save the fact 'Acme'",
    });
    expect(r.id).toBe("pa-123");
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO instinct_pending_actions"),
      expect.arrayContaining(["u1", "save_team_fact"]),
    );
  });

  test("returns a fallback id on DB error (never throws)", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("DB down"));
    const r = await savePendingAction({
      userId: "u1",
      toolName: "t",
      params: {},
      description: "x",
    });
    expect(r.id).toMatch(/^error-/);
  });
});

describe("consumeMostRecentPendingAction", () => {
  test("returns null in shadow mode", async () => {
    delete process.env.DATABASE_URL;
    expect(await consumeMostRecentPendingAction("u1", "confirm")).toBeNull();
  });

  test("returns the consumed row when one was claimed", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "pa-1",
          user_id: "u1",
          tool_name: "save_team_fact",
          params: { subject: "Acme" },
          description: "save",
          created_at: "2026-05-14T12:00:00Z",
          expires_at: "2026-05-14T12:05:00Z",
        },
      ],
    });
    const r = await consumeMostRecentPendingAction("u1", "confirm");
    expect(r?.id).toBe("pa-1");
    expect(r?.tool_name).toBe("save_team_fact");
    /* The UPDATE locks the row with SKIP LOCKED so the SQL must
       reference both clauses. */
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/consumed_at = now\(\)/);
  });

  test("returns null when no live pending row exists", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await consumeMostRecentPendingAction("u1", "confirm")).toBeNull();
  });

  test("returns null on DB error (never throws)", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("boom"));
    expect(await consumeMostRecentPendingAction("u1", "confirm")).toBeNull();
  });
});

describe("cleanupExpiredPendingActions", () => {
  test("returns the row-count of lapsed actions", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] });
    expect(await cleanupExpiredPendingActions()).toBe(3);
  });

  test("returns 0 in shadow mode", async () => {
    delete process.env.DATABASE_URL;
    expect(await cleanupExpiredPendingActions()).toBe(0);
  });

  test("returns 0 on DB error", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("x"));
    expect(await cleanupExpiredPendingActions()).toBe(0);
  });
});
