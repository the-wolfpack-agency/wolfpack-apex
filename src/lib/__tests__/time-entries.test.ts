/**
 * Lib tests for time-entries: recordTimeEntry, listTimeEntries,
 * summarizeTimeEntries, normalizeJobCode.
 */

const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

import {
  recordTimeEntry,
  listTimeEntries,
  summarizeTimeEntries,
  normalizeJobCode,
} from "@/lib/time-entries";

beforeEach(() => jest.clearAllMocks());

describe("normalizeJobCode", () => {
  it("uppercases + trims + collapses spaces", () => {
    expect(normalizeJobCode("  wolfpack-auto  ")).toBe("WOLFPACK-AUTO");
    expect(normalizeJobCode("client  acme")).toBe("CLIENT ACME");
  });
});

describe("recordTimeEntry validation", () => {
  it("rejects missing/over-length job_code", async () => {
    await expect(recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "", hours: 1 })).rejects.toThrow(/job_code/);
    await expect(recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "A".repeat(65), hours: 1 })).rejects.toThrow(/job_code/);
  });
  it("rejects out-of-range hours", async () => {
    await expect(recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "X", hours: 0 })).rejects.toThrow(/hours/);
    await expect(recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "X", hours: 25 })).rejects.toThrow(/hours/);
    await expect(recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "X", hours: NaN })).rejects.toThrow(/hours/);
  });
  it("rejects bad loggedForDate format", async () => {
    await expect(
      recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "X", hours: 1, loggedForDate: "yesterday" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("recordTimeEntry happy path", () => {
  it("normalizes code, defaults date, inserts via writeQuery, fires analytics", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{
        id: "u1", workspace_id: "default", user_id: "tm_x", user_email: "u@x.com", user_role: "ops",
        job_code: "WOLFPACK-AUTO", hours: 1.5, notes: null, logged_for_date: "2026-05-20", created_at: "t",
      }],
    });
    const row = await recordTimeEntry({
      workspaceId: "default",
      userId: "tm_x",
      userEmail: "u@x.com",
      userRole: "ops",
      jobCode: "  wolfpack-auto  ",
      hours: 1.5,
    });
    expect(row.job_code).toBe("WOLFPACK-AUTO");
    const [, args, opts] = mockWriteQuery.mock.calls[0];
    expect(args[4]).toBe("WOLFPACK-AUTO");
    expect(args[5]).toBe(1.5);
    expect(args[7]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaulted to today
    expect(opts).toEqual({ expectRows: 1 });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.time_entry_recorded",
      "tm_x",
      "ops",
      expect.objectContaining({ job_code: "WOLFPACK-AUTO", hours: 1.5 }),
    );
  });

  it("truncates notes to MAX_NOTES_LENGTH", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "u1", job_code: "X", hours: 1, notes: "n", logged_for_date: "2026-05-20", created_at: "t" }] });
    await recordTimeEntry({ workspaceId: "w", userId: "u", jobCode: "X", hours: 1, notes: "a".repeat(700) });
    const args = mockWriteQuery.mock.calls[0][1];
    expect((args[6] as string).length).toBe(500);
  });
});

describe("listTimeEntries", () => {
  it("filters by workspace + user + since/until + clamps limit", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listTimeEntries({ workspaceId: "w", userId: "u", since: "2026-05-01", until: "2026-05-20", limit: 50_000 });
    const [sql, args] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/workspace_id = \$1/);
    expect(sql).toMatch(/user_id = \$2/);
    expect(sql).toMatch(/logged_for_date >= \$3/);
    expect(sql).toMatch(/logged_for_date <= \$4/);
    expect(sql).toMatch(/LIMIT 1000/); // clamped
    expect(args).toEqual(["w", "u", "2026-05-01", "2026-05-20"]);
  });

  it("ignores malformed date strings", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listTimeEntries({ workspaceId: "w", since: "yesterday" });
    const [sql, args] = mockSafeQuery.mock.calls[0];
    expect(sql).not.toMatch(/logged_for_date >=/);
    expect(args).toEqual(["w"]);
  });
});

describe("summarizeTimeEntries", () => {
  it("groups by user + job_code, orders by total_hours DESC", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await summarizeTimeEntries({ workspaceId: "w", since: "2026-05-01" });
    const [sql, args] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/GROUP BY user_id, job_code/);
    expect(sql).toMatch(/ORDER BY total_hours DESC/);
    expect(args).toEqual(["w", "2026-05-01"]);
  });
});
