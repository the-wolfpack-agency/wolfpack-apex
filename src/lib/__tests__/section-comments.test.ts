/**
 * section-comments.ts — orchestration tests.
 *
 * Mocks:
 *   - @/lib/db (writeQuery + safeQuery) — asserts SQL, params, and
 *     that every write goes through writeQuery with expectRows: 1.
 *
 * Covers:
 *   - postComment inserts via writeQuery with expectRows: 1
 *   - postComment rejects body > COMMENT_BODY_MAX with typed error
 *   - postComment rejects empty body with typed error
 *   - postComment rejects bad indices with typed error
 *   - postComment truncates actor_name / actor_email / section_type
 *   - listCommentsForSite returns newest-first
 *   - listCommentsForSite openOnly filter adds state = 'open' clause
 *   - resolveComment recursively updates via CTE
 *   - resolveComment returns parent record from RETURNING
 *   - resolveComment falls through to SELECT when already resolved
 *   - deleteComment soft-deletes via UPDATE ... body = '[deleted]'
 *   - getComment returns a record or null
 *   - WriteQueryError propagates (no silent swallow)
 */

const writeQueryMock = jest.fn();
const safeQueryMock = jest.fn();

class WriteQueryErrorMock extends Error {
  code: string;
  expected?: number;
  actual?: number;
  constructor(
    message: string,
    code: string,
    extra?: { expected?: number; actual?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "WriteQueryError";
    this.code = code;
    this.expected = extra?.expected;
    this.actual = extra?.actual;
  }
}

jest.mock("@/lib/db", () => ({
  writeQuery: (...args: unknown[]) => writeQueryMock(...args),
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
  WriteQueryError: WriteQueryErrorMock,
}));

import {
  postComment,
  listCommentsForSite,
  resolveComment,
  deleteComment,
  getComment,
  CommentValidationError,
  COMMENT_BODY_MAX,
} from "@/lib/section-comments";

const baseRow = {
  id: "c1",
  site_id: "site_1",
  share_token_id: null,
  page_index: 0,
  section_index: 1,
  section_type: "hero",
  body: "Looks great",
  actor_name: "Alice",
  actor_email: "a@example.com",
  parent_comment_id: null,
  state: "open",
  resolved_by: null,
  resolved_at: null,
  created_at: "2026-04-19T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("postComment", () => {
  it("inserts via writeQuery with expectRows: 1 and returns a SectionComment", async () => {
    writeQueryMock.mockResolvedValueOnce({ rows: [baseRow] });
    const rec = await postComment({
      siteId: "site_1",
      pageIndex: 0,
      sectionIndex: 1,
      sectionType: "hero",
      body: "Looks great",
      actorName: "Alice",
      actorEmail: "a@example.com",
      shareTokenId: "tok_1",
    });
    expect(rec.id).toBe("c1");
    expect(rec.body).toBe("Looks great");
    expect(rec.state).toBe("open");
    // expectRows: 1 is the load-bearing assertion for "no silent drop".
    const call = writeQueryMock.mock.calls[0];
    expect(call[2]).toEqual({ expectRows: 1 });
  });

  it("throws CommentValidationError when body exceeds COMMENT_BODY_MAX", async () => {
    const big = "x".repeat(COMMENT_BODY_MAX + 1);
    await expect(
      postComment({
        siteId: "site_1",
        pageIndex: 0,
        sectionIndex: 0,
        body: big,
      }),
    ).rejects.toBeInstanceOf(CommentValidationError);
    expect(writeQueryMock).not.toHaveBeenCalled();
  });

  it("throws CommentValidationError code body_too_long specifically", async () => {
    const big = "y".repeat(COMMENT_BODY_MAX + 10);
    try {
      await postComment({
        siteId: "site_1",
        pageIndex: 0,
        sectionIndex: 0,
        body: big,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CommentValidationError);
      expect((err as CommentValidationError).code).toBe("body_too_long");
    }
  });

  it("rejects empty / whitespace-only bodies with body_empty", async () => {
    await expect(
      postComment({
        siteId: "site_1",
        pageIndex: 0,
        sectionIndex: 0,
        body: "   ",
      }),
    ).rejects.toMatchObject({ code: "body_empty" });
    expect(writeQueryMock).not.toHaveBeenCalled();
  });

  it("rejects negative or non-integer indices with bad_index", async () => {
    await expect(
      postComment({ siteId: "site_1", pageIndex: -1, sectionIndex: 0, body: "x" }),
    ).rejects.toMatchObject({ code: "bad_index" });
    await expect(
      postComment({ siteId: "site_1", pageIndex: 0, sectionIndex: 1.5, body: "x" }),
    ).rejects.toMatchObject({ code: "bad_index" });
  });

  it("rejects missing siteId with bad_site_id", async () => {
    await expect(
      postComment({ siteId: "", pageIndex: 0, sectionIndex: 0, body: "x" }),
    ).rejects.toMatchObject({ code: "bad_site_id" });
  });

  it("truncates overlong actor fields before insert", async () => {
    writeQueryMock.mockResolvedValueOnce({ rows: [baseRow] });
    const longName = "n".repeat(500);
    const longEmail = "e".repeat(500) + "@x.com";
    const longSectionType = "t".repeat(128);
    await postComment({
      siteId: "site_1",
      pageIndex: 0,
      sectionIndex: 0,
      body: "hello",
      actorName: longName,
      actorEmail: longEmail,
      sectionType: longSectionType,
    });
    const params = writeQueryMock.mock.calls[0][1];
    // Params order: site, token, page, section, sectionType, body, name, email, parent
    expect((params[4] as string).length).toBeLessThanOrEqual(64);
    expect((params[6] as string).length).toBeLessThanOrEqual(200);
    expect((params[7] as string).length).toBeLessThanOrEqual(320);
  });

  it("treats whitespace-only actor fields as null params", async () => {
    writeQueryMock.mockResolvedValueOnce({ rows: [baseRow] });
    await postComment({
      siteId: "site_1",
      pageIndex: 0,
      sectionIndex: 0,
      body: "hello",
      actorName: "   ",
      actorEmail: "  ",
      sectionType: " ",
    });
    const params = writeQueryMock.mock.calls[0][1];
    expect(params[4]).toBeNull(); // section_type
    expect(params[6]).toBeNull(); // actor_name
    expect(params[7]).toBeNull(); // actor_email
  });

  it("propagates WriteQueryError (no silent swallow)", async () => {
    writeQueryMock.mockRejectedValueOnce(
      new WriteQueryErrorMock("RLS blocked", "db_error"),
    );
    await expect(
      postComment({
        siteId: "site_1",
        pageIndex: 0,
        sectionIndex: 0,
        body: "hi",
      }),
    ).rejects.toHaveProperty("code", "db_error");
  });
});

describe("listCommentsForSite", () => {
  it("returns newest-first (ORDER BY created_at DESC in SQL)", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        { ...baseRow, id: "c2", created_at: "2026-04-19T01:00:00Z" },
        { ...baseRow, id: "c1", created_at: "2026-04-19T00:00:00Z" },
      ],
      fromCache: false,
    });
    const rows = await listCommentsForSite("site_1");
    expect(rows.map((r) => r.id)).toEqual(["c2", "c1"]);
    const sql = String(safeQueryMock.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    // Default = no openOnly filter.
    expect(sql).not.toMatch(/state = 'open'/);
  });

  it("applies state='open' filter when openOnly: true", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await listCommentsForSite("site_1", { openOnly: true });
    const sql = String(safeQueryMock.mock.calls[0][0]);
    expect(sql).toMatch(/state = 'open'/);
  });

  it("returns [] in shadow mode (safeQuery empty rows)", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: true });
    const rows = await listCommentsForSite("site_none");
    expect(rows).toEqual([]);
  });
});

describe("resolveComment", () => {
  it("uses a recursive CTE and passes commentId + userId", async () => {
    writeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          ...baseRow,
          id: "c1",
          state: "resolved",
          resolved_by: "u_1",
          resolved_at: "2026-04-19T02:00:00Z",
        },
      ],
    });
    const rec = await resolveComment({ commentId: "c1", userId: "u_1" });
    expect(rec.state).toBe("resolved");
    expect(rec.resolvedBy).toBe("u_1");
    const sql = String(writeQueryMock.mock.calls[0][0]);
    expect(sql).toMatch(/WITH RECURSIVE/);
    expect(sql).toMatch(/descendants/);
    const params = writeQueryMock.mock.calls[0][1];
    expect(params).toEqual(["c1", "u_1"]);
  });

  it("returns the parent record from RETURNING when parent was open", async () => {
    writeQueryMock.mockResolvedValueOnce({
      rows: [
        { ...baseRow, id: "child1", parent_comment_id: "c1", state: "resolved" },
        { ...baseRow, id: "c1", state: "resolved" },
      ],
    });
    const rec = await resolveComment({ commentId: "c1", userId: "u_1" });
    expect(rec.id).toBe("c1");
  });

  it("falls through to SELECT when the comment was already resolved", async () => {
    // The UPDATE returns nothing because WHERE state='open' filtered it.
    writeQueryMock.mockResolvedValueOnce({ rows: [] });
    // Subsequent SELECT returns the current (resolved) record.
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ ...baseRow, id: "c1", state: "resolved" }],
      fromCache: false,
    });
    const rec = await resolveComment({ commentId: "c1", userId: "u_1" });
    expect(rec.id).toBe("c1");
    expect(rec.state).toBe("resolved");
  });

  it("rejects missing commentId", async () => {
    await expect(
      resolveComment({ commentId: "", userId: "u_1" }),
    ).rejects.toBeInstanceOf(CommentValidationError);
  });
});

describe("deleteComment", () => {
  it("soft-deletes via UPDATE with expectRows: 1", async () => {
    writeQueryMock.mockResolvedValueOnce({ rows: [{}] });
    await deleteComment({ commentId: "c1", userId: "u_1" });
    const call = writeQueryMock.mock.calls[0];
    const sql = String(call[0]);
    expect(sql).toMatch(/UPDATE instinct_site_section_comments/);
    expect(sql).toMatch(/body = '\[deleted\]'/);
    expect(call[2]).toEqual({ expectRows: 1 });
  });

  it("propagates a row-count mismatch (silent-drop trap)", async () => {
    writeQueryMock.mockRejectedValueOnce(
      new WriteQueryErrorMock("row-count mismatch", "unexpected_row_count", {
        expected: 1,
        actual: 0,
      }),
    );
    await expect(
      deleteComment({ commentId: "cX", userId: "u_1" }),
    ).rejects.toHaveProperty("code", "unexpected_row_count");
  });

  it("rejects missing commentId", async () => {
    await expect(
      deleteComment({ commentId: "", userId: "u_1" }),
    ).rejects.toBeInstanceOf(CommentValidationError);
  });
});

describe("getComment", () => {
  it("returns the record when found", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [baseRow], fromCache: false });
    const rec = await getComment("c1");
    expect(rec?.id).toBe("c1");
  });

  it("returns null when not found", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    const rec = await getComment("missing");
    expect(rec).toBeNull();
  });
});
