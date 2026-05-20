/**
 * Lib tests for resolve-feedback + reopen-feedback.
 */

const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({ writeQuery: (...a: any[]) => mockWriteQuery(...a) }));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

import { resolveFeedback, reopenFeedback } from "@/lib/feedback/resolve-feedback";

beforeEach(() => jest.clearAllMocks());

describe("resolveFeedback", () => {
  it("requires workspaceId / feedbackId / resolverId", async () => {
    await expect(resolveFeedback({ workspaceId: "", feedbackId: "f", resolverId: "u" })).rejects.toThrow(/workspaceId/);
    await expect(resolveFeedback({ workspaceId: "w", feedbackId: "", resolverId: "u" })).rejects.toThrow(/feedbackId/);
    await expect(resolveFeedback({ workspaceId: "w", feedbackId: "f", resolverId: "" })).rejects.toThrow(/resolverId/);
  });

  it("UPDATE fires with normalized note + RETURNING resolved row + analytics", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "f1", resolved_at: "2026-05-20T17:00:00Z", resolved_by: "u1", resolution_note: "fixed in PR #42" }],
    });
    const row = await resolveFeedback({
      workspaceId: "default",
      feedbackId: "f1",
      resolverId: "u1",
      resolverRole: "cto",
      note: "  fixed in PR #42  ",
    });
    expect(row.id).toBe("f1");
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, args, opts] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_user_feedback/);
    expect(sql).toMatch(/resolved_at = NOW/);
    expect(args).toEqual(["u1", "fixed in PR #42", "f1", "default"]);
    expect(opts).toEqual({ expectRows: 1 });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.feedback_resolved",
      "u1",
      "cto",
      expect.objectContaining({ feedback_id: "f1", has_note: true }),
    );
  });

  it("empty / whitespace-only note normalized to null", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "f1", resolved_at: "x", resolved_by: "u1", resolution_note: null }] });
    await resolveFeedback({ workspaceId: "w", feedbackId: "f1", resolverId: "u1", note: "   " });
    const args = mockWriteQuery.mock.calls[0][1];
    expect(args[1]).toBeNull();
    expect(mockTrackEvent.mock.calls[0][3]).toEqual(expect.objectContaining({ has_note: false }));
  });

  it("rejects when writeQuery returns no row (workspace mismatch)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveFeedback({ workspaceId: "w", feedbackId: "f", resolverId: "u" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("reopenFeedback", () => {
  it("UPDATE clears resolved fields + fires reopen analytics", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "f1", resolved_at: null, resolved_by: null, resolution_note: null }],
    });
    const row = await reopenFeedback({
      workspaceId: "default",
      feedbackId: "f1",
      reopenerId: "u1",
      reopenerRole: "cto",
    });
    expect(row.resolved_at).toBeNull();
    const sql = mockWriteQuery.mock.calls[0][0];
    expect(sql).toMatch(/resolved_at = NULL/);
    expect(sql).toMatch(/resolved_by = NULL/);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.feedback_reopened",
      "u1",
      "cto",
      expect.objectContaining({ feedback_id: "f1" }),
    );
  });
});
