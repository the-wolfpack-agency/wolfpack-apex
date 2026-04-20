/**
 * Discussion Library Tests
 */

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
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
  getThreads,
  getThread,
  pinThread,
} from "@/lib/discussions";

describe("Discussions Library", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createThread", () => {
    it("creates a discussion and inserts initial reply", async () => {
      const mockDiscussion = {
        id: "disc-1",
        title: "Q2 Planning",
        category: "product",
        created_by: "user-1",
        status: "open",
        pinned: false,
        tags: ["planning"],
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      };

      mockSafeQuery
        .mockResolvedValueOnce({ rows: [mockDiscussion], fromCache: false }) // insert discussion
        .mockResolvedValueOnce({ rows: [], fromCache: false }); // insert reply

      const result = await createThread("Q2 Planning", "product", "user-1", "Let's plan Q2", ["planning"]);

      expect(result).toEqual({ ...mockDiscussion, reply_count: 1 });
      expect(mockSafeQuery).toHaveBeenCalledTimes(2);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("INSERT INTO instinct_discussions");
      expect(mockSafeQuery.mock.calls[1][0]).toContain("INSERT INTO instinct_discussion_replies");
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "discussion.thread_created",
        "user-1",
        "unknown",
        expect.objectContaining({ discussion_id: "disc-1", category: "product" }),
      );
    });

    it("returns demo data in shadow mode", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });

      const result = await createThread("Test", "general", "user-1", "Content");

      expect(result).not.toBeNull();
      expect(result!.id).toMatch(/^demo-disc-/);
      expect(result!.reply_count).toBe(1);
    });
  });

  describe("replyToThread", () => {
    it("inserts a reply and bumps discussion timestamp", async () => {
      const mockReply = {
        id: "reply-1",
        discussion_id: "disc-1",
        author_id: "user-1",
        content: "Great idea!",
        attachments: [],
        created_at: "2026-01-01",
      };

      mockSafeQuery
        .mockResolvedValueOnce({ rows: [mockReply], fromCache: false })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await replyToThread("disc-1", "user-1", "Great idea!");

      expect(result).toEqual(mockReply);
      expect(mockSafeQuery).toHaveBeenCalledTimes(2);
      expect(mockSafeQuery.mock.calls[1][0]).toContain("UPDATE instinct_discussions");
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "discussion.reply_posted",
        "user-1",
        "unknown",
        expect.objectContaining({ discussion_id: "disc-1" }),
      );
    });

    it("returns demo reply in shadow mode", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });

      const result = await replyToThread("disc-1", "user-1", "Shadow reply");

      expect(result).not.toBeNull();
      expect(result!.id).toMatch(/^demo-reply-/);
      expect(result!.content).toBe("Shadow reply");
    });
  });

  describe("resolveThread", () => {
    it("marks thread as resolved and tracks analytics", async () => {
      const resolved = { id: "disc-1", status: "resolved" };
      mockSafeQuery.mockResolvedValueOnce({ rows: [resolved], fromCache: false });

      const result = await resolveThread("disc-1", "user-1");

      expect(result).toEqual(resolved);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("status = 'resolved'");
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "discussion.resolved",
        "user-1",
        "unknown",
        expect.objectContaining({ discussion_id: "disc-1" }),
      );
    });

    it("returns null for non-existent thread", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await resolveThread("non-existent", "user-1");
      expect(result).toBeNull();
    });
  });

  describe("getThreads", () => {
    it("returns threads with reply counts", async () => {
      const threads = [
        { id: "disc-1", title: "Test", reply_count: 3 },
        { id: "disc-2", title: "Test 2", reply_count: 1 },
      ];
      mockSafeQuery.mockResolvedValueOnce({ rows: threads, fromCache: false });

      const result = await getThreads();

      expect(result).toEqual(threads);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("reply_count");
      expect(mockSafeQuery.mock.calls[0][0]).toContain("ORDER BY d.pinned DESC");
    });

    it("filters by category", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getThreads("engineering");

      expect(mockSafeQuery.mock.calls[0][0]).toContain("d.category = $1");
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["engineering"]);
    });

    it("filters by status", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getThreads(undefined, "open");

      expect(mockSafeQuery.mock.calls[0][0]).toContain("d.status = $1");
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["open"]);
    });
  });

  describe("getThread", () => {
    it("returns discussion with all replies and author info", async () => {
      const discussion = { id: "disc-1", title: "Q2", reply_count: 2 };
      const replies = [
        { id: "r-1", discussion_id: "disc-1", author_id: "u-1", content: "First", author_name: "Dev", author_role: "dev" },
        { id: "r-2", discussion_id: "disc-1", author_id: "u-2", content: "Second", author_name: "CTO", author_role: "cto" },
      ];

      mockSafeQuery
        .mockResolvedValueOnce({ rows: [discussion], fromCache: false })
        .mockResolvedValueOnce({ rows: replies, fromCache: false });

      const result = await getThread("disc-1");

      expect(result).toEqual({ discussion, replies });
      expect(mockSafeQuery.mock.calls[1][0]).toContain("LEFT JOIN instinct_team_members");
    });

    it("returns null for non-existent thread", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await getThread("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("pinThread", () => {
    it("toggles pin for cto role", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ pinned: true }], fromCache: false });

      const result = await pinThread("disc-1", "user-1", "cto");

      expect(result).toEqual({ pinned: true });
      expect(mockSafeQuery.mock.calls[0][0]).toContain("pinned = NOT pinned");
    });

    it("toggles pin for dev role", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ pinned: false }], fromCache: false });

      const result = await pinThread("disc-1", "user-1", "dev");

      expect(result).toEqual({ pinned: false });
    });

    it("rejects pin for sales role", async () => {
      const result = await pinThread("disc-1", "user-1", "sales");

      expect(result).toEqual({ error: expect.stringContaining("Insufficient permissions") });
      expect(mockSafeQuery).not.toHaveBeenCalled();
    });

    it("rejects pin for ops role", async () => {
      const result = await pinThread("disc-1", "user-1", "ops");

      expect(result).toEqual({ error: expect.stringContaining("Insufficient permissions") });
    });

    it("returns error for non-existent discussion", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await pinThread("non-existent", "user-1", "cto");

      expect(result).toEqual({ error: "Discussion not found" });
    });
  });
});
