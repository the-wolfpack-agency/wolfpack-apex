/**
 * Analytics / learning-loop regression tests for the discussions family.
 *
 * Per the permanent engineering directive: "Every new piece of code ties
 * into the data and learning mechanism. No data lost. All data consumed
 * to benefit the system. Analytics events, audit log entries... are the
 * default, not afterthoughts."
 *
 * The Tier 4 batch 5 U5 rename of apex_discussions/apex_discussion_replies
 * → instinct_discussions/instinct_discussion_replies is a schema-layer
 * change. It must NOT silently break the analytics events that fire on
 * every discussion action. A missed trackEvent call = a gap in the
 * learning loop = no data to train on for the analytics brain.
 *
 * This suite pins the exact analytics signature for every public path in
 * src/lib/discussions.ts so any future refactor (further renames, schema
 * tweaks, handler restructures) trips a test before it lands in prod.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/auth", () => ({
  hasRole: (userRole: string, requiredRole: string) => {
    const levels: Record<string, number> = { cto: 5, ceo: 4, dev: 3, ops: 2, sales: 1 };
    return (levels[userRole] || 0) >= (levels[requiredRole] || 0);
  },
}));

import {
  createThread,
  replyToThread,
  resolveThread,
  pinThread,
} from "@/lib/discussions";

describe("discussions analytics integration (post-rename)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fires discussion.thread_created when a new thread is created against instinct_discussions", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ id: "d-1", title: "T", category: "product", created_by: "u-1", status: "open", pinned: false, tags: [], created_at: "x", updated_at: "x" }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    await createThread("T", "product", "u-1", "body");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.thread_created",
      "u-1",
      "unknown",
      expect.objectContaining({ discussion_id: "d-1", category: "product" }),
    );
    // And the SQL must target the renamed tables.
    expect(mockSafeQuery.mock.calls[0][0]).toContain("instinct_discussions");
    expect(mockSafeQuery.mock.calls[1][0]).toContain("instinct_discussion_replies");
  });

  it("fires discussion.reply_posted when a reply lands on instinct_discussion_replies", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: "r-1", discussion_id: "d-1", author_id: "u-1", content: "c", attachments: [], created_at: "x" }], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    await replyToThread("d-1", "u-1", "c");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.reply_posted",
      "u-1",
      "unknown",
      expect.objectContaining({ discussion_id: "d-1", reply_id: "r-1" }),
    );
    expect(mockSafeQuery.mock.calls[0][0]).toContain("instinct_discussion_replies");
    expect(mockSafeQuery.mock.calls[1][0]).toContain("instinct_discussions");
  });

  it("fires discussion.resolved when a thread is marked resolved on instinct_discussions", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "d-1", status: "resolved" }],
      fromCache: false,
    });

    await resolveThread("d-1", "u-1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.resolved",
      "u-1",
      "unknown",
      expect.objectContaining({ discussion_id: "d-1" }),
    );
    expect(mockSafeQuery.mock.calls[0][0]).toContain("instinct_discussions");
  });

  it("fires an analytics event when a thread is pinned via instinct_discussions", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ pinned: true }], fromCache: false });

    await pinThread("d-1", "u-1", "cto");

    // pinThread currently reuses the discussion.thread_created event name
    // with action=pin_toggled — lock in whatever the current shape is so
    // any accidental drop is caught immediately.
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [eventName, userId, role, payload] = mockTrackEvent.mock.calls[0];
    expect(typeof eventName).toBe("string");
    expect(eventName.startsWith("discussion.")).toBe(true);
    expect(userId).toBe("u-1");
    expect(role).toBe("cto");
    expect(payload).toEqual(expect.objectContaining({ discussion_id: "d-1", action: "pin_toggled", pinned: true }));
    expect(mockSafeQuery.mock.calls[0][0]).toContain("instinct_discussions");
  });

  it("does NOT fire an analytics event when pinThread is rejected by role check", async () => {
    const result = await pinThread("d-1", "u-1", "sales");

    // Role check rejects before any DB or analytics work.
    expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("does NOT fire an event when resolveThread finds no matching row", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await resolveThread("does-not-exist", "u-1");

    expect(result).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
