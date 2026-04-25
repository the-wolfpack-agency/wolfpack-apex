/**
 * audit-repo — unit tests.
 *
 * Mocks `@/lib/db` so we can drive the SQL helpers without Postgres.
 * Verifies:
 *   - recordAction inserts and returns the persisted record
 *   - listActionsForClass / listActionsForAutomation issue the right
 *     filters
 *   - getActionById null-handling
 *   - revertAction marks the row, idempotent on already-reverted
 *   - isWithinUndoWindow boundary semantics (under/over 24h, bad input)
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: class extends Error {},
}));

import {
  recordAction,
  listActionsForClass,
  listActionsForAutomation,
  getActionById,
  revertAction,
  isWithinUndoWindow,
  UNDO_WINDOW_MS,
} from "@/lib/automations/porsche-classes/audit-repo";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("recordAction", () => {
  it("inserts the row and returns the persisted record", async () => {
    const persisted = {
      id: "audit-1",
      automation_id: "porsche-classes",
      action_kind: "sharepoint_upload",
      target_ref: "BA101|2026-04-13|Westlake",
      detail: { item_id: "01ABC", web_url: "https://x", filename: "x.docx" },
      actor: "alicia@example.com",
      reverted_at: null,
      reverted_by: null,
      created_at: "2026-04-25T10:00:00.000Z",
    };
    mockWriteQuery.mockResolvedValueOnce({ rows: [persisted] });

    const out = await recordAction({
      automation_id: "porsche-classes",
      action_kind: "sharepoint_upload",
      target_ref: "BA101|2026-04-13|Westlake",
      actor: "alicia@example.com",
      detail: {
        item_id: "01ABC",
        web_url: "https://x",
        filename: "x.docx",
      },
    });
    expect(out).toEqual(persisted);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params, opts] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_automation_audit_actions/);
    expect(params).toEqual([
      "porsche-classes",
      "sharepoint_upload",
      "BA101|2026-04-13|Westlake",
      JSON.stringify({
        item_id: "01ABC",
        web_url: "https://x",
        filename: "x.docx",
      }),
      "alicia@example.com",
    ]);
    expect(opts).toEqual({ expectRows: 1 });
  });

  it("propagates writeQuery errors (no silent loss)", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("pg down"));
    await expect(
      recordAction({
        automation_id: "porsche-classes",
        action_kind: "class_match_merge",
        target_ref: "k",
        actor: "u",
        detail: { override_id: "o", from_value: "a", to_value: "b" },
      }),
    ).rejects.toThrow(/pg down/);
  });
});

describe("listActionsForClass", () => {
  it("filters by target_ref + applies since when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listActionsForClass("BA101|2026-04-13|Westlake", {
      since: "2026-04-25T00:00:00.000Z",
      limit: 50,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE target_ref = \$1/);
    expect(sql).toMatch(/created_at >= \$2/);
    expect(sql).toMatch(/LIMIT 50/);
    expect(params).toEqual([
      "BA101|2026-04-13|Westlake",
      "2026-04-25T00:00:00.000Z",
    ]);
  });

  it("clamps limit to a sane range", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listActionsForClass("k", { limit: 99999 });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT 500/); // capped at 500
  });

  it("uses default limit when none provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listActionsForClass("k");
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT 100/);
  });
});

describe("listActionsForAutomation", () => {
  it("filters by automation_id and (optionally) class_key + since", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listActionsForAutomation({
      automation_id: "porsche-classes",
      class_key: "k",
      since: "2026-04-24T00:00:00.000Z",
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE automation_id = \$1/);
    expect(sql).toMatch(/target_ref = \$2/);
    expect(sql).toMatch(/created_at >= \$3/);
    expect(params).toEqual([
      "porsche-classes",
      "k",
      "2026-04-24T00:00:00.000Z",
    ]);
  });
});

describe("getActionById", () => {
  it("returns null when the row is missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getActionById("missing");
    expect(out).toBeNull();
  });
  it("returns the row when present", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "a-1", action_kind: "class_match_merge" }],
    });
    const out = await getActionById("a-1");
    expect(out?.id).toBe("a-1");
  });
});

describe("revertAction", () => {
  it("marks the row reverted_at + reverted_by", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "a-1", reverted_at: "now", reverted_by: "u" }],
    });
    const out = await revertAction("a-1", "u");
    expect(out?.id).toBe("a-1");
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_automation_audit_actions/);
    expect(sql).toMatch(/reverted_at IS NULL/);
    expect(params).toEqual(["a-1", "u"]);
  });
  it("returns null when row was already reverted (UPDATE matched 0 rows)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const out = await revertAction("a-1", "u");
    expect(out).toBeNull();
  });
});

describe("isWithinUndoWindow", () => {
  const now = new Date("2026-04-25T10:00:00.000Z");
  it("returns true for a row 1ms old", () => {
    expect(
      isWithinUndoWindow(new Date(now.getTime() - 1).toISOString(), now),
    ).toBe(true);
  });
  it("returns true for a row 23h59m old", () => {
    const t = new Date(now.getTime() - (UNDO_WINDOW_MS - 60_000)).toISOString();
    expect(isWithinUndoWindow(t, now)).toBe(true);
  });
  it("returns false for a row 24h+1ms old", () => {
    const t = new Date(now.getTime() - (UNDO_WINDOW_MS + 1)).toISOString();
    expect(isWithinUndoWindow(t, now)).toBe(false);
  });
  it("returns false for an unparseable timestamp", () => {
    expect(isWithinUndoWindow("not-a-date", now)).toBe(false);
  });
});
