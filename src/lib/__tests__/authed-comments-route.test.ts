/**
 * /api/sites/[id]/comments + /[commentId]/resolve + [commentId] DELETE
 * route tests.
 *
 * Covers:
 *   - GET 401 without auth
 *   - GET 403 without required role
 *   - GET 200 returns the list, filter= param works
 *   - POST 200 posts a comment with via_share_token=false
 *   - POST 400 on bad body
 *   - POST fires site.comment_replied when parentCommentId present
 *   - Resolve 200 + analytics
 *   - Resolve 404 when the comment belongs to a different site
 *   - Delete soft-deletes + analytics
 */

const mockGetUser = jest.fn();
const mockHasRole = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  hasRole: (...args: unknown[]) => mockHasRole(...args),
}));

const mockGetSite = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...args: unknown[]) => mockGetSite(...args),
}));

const mockListComments = jest.fn();
const mockPostComment = jest.fn();
const mockResolve = jest.fn();
const mockDelete = jest.fn();
const mockGetComment = jest.fn();

class CommentValidationErrorMock extends Error {
  code: string;
  constructor(msg: string, code: string) {
    super(msg);
    this.name = "CommentValidationError";
    this.code = code;
  }
}

jest.mock("@/lib/section-comments", () => ({
  listCommentsForSite: (...args: unknown[]) => mockListComments(...args),
  postComment: (...args: unknown[]) => mockPostComment(...args),
  resolveComment: (...args: unknown[]) => mockResolve(...args),
  deleteComment: (...args: unknown[]) => mockDelete(...args),
  getComment: (...args: unknown[]) => mockGetComment(...args),
  CommentValidationError: CommentValidationErrorMock,
  COMMENT_BODY_MAX: 5000,
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

class WriteQueryErrorMock extends Error {
  code: string;
  constructor(msg: string, code: string) {
    super(msg);
    this.name = "WriteQueryError";
    this.code = code;
  }
}

jest.mock("@/lib/db", () => ({
  WriteQueryError: WriteQueryErrorMock,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/sites/[id]/comments/route";
import { POST as RESOLVE_POST } from "@/app/api/sites/[id]/comments/[commentId]/resolve/route";
import { DELETE as DELETE_COMMENT } from "@/app/api/sites/[id]/comments/[commentId]/route";

const AUTHED_USER = {
  id: "u_1",
  email: "dev@wolfpack.agency",
  name: "Dev User",
  role: "dev",
  created_at: "",
};

const GOOD_COMMENT = {
  id: "c1",
  siteId: "site_1",
  shareTokenId: null,
  pageIndex: 0,
  sectionIndex: 1,
  sectionType: "hero",
  body: "Hello",
  actorName: "Dev User",
  actorEmail: "dev@wolfpack.agency",
  parentCommentId: null,
  state: "open" as const,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-04-19T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue(AUTHED_USER);
  mockHasRole.mockReturnValue(true);
  mockGetSite.mockResolvedValue({ id: "site_1", display_name: "Site 1" });
  mockListComments.mockResolvedValue([GOOD_COMMENT]);
  mockPostComment.mockResolvedValue(GOOD_COMMENT);
  mockResolve.mockResolvedValue({ ...GOOD_COMMENT, state: "resolved" });
  mockGetComment.mockResolvedValue(GOOD_COMMENT);
});

function authedReq(url: string, opts: RequestInit = {}) {
  // NextRequest's RequestInit differs slightly from the DOM RequestInit
  // (signal nullability); cast through unknown to match the other test
  // files in the suite.
  return new NextRequest(url, {
    ...opts,
    headers: {
      authorization: "Bearer good-jwt",
      "content-type": "application/json",
      ...(opts.headers as Record<string, string> | undefined),
    },
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

describe("GET /api/sites/[id]/comments", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await GET(new NextRequest("http://test/api/sites/site_1/comments"), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 when role is insufficient", async () => {
    mockHasRole.mockReturnValueOnce(false);
    const res = await GET(
      authedReq("http://test/api/sites/site_1/comments"),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("404 when the site does not exist", async () => {
    mockGetSite.mockResolvedValueOnce(null);
    const res = await GET(
      authedReq("http://test/api/sites/nope/comments"),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(404);
  });

  it("200 returns all comments", async () => {
    const res = await GET(
      authedReq("http://test/api/sites/site_1/comments"),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comments).toHaveLength(1);
  });

  it("filter=open narrows the list to open comments", async () => {
    mockListComments.mockResolvedValueOnce([
      GOOD_COMMENT,
      { ...GOOD_COMMENT, id: "c2", state: "resolved" },
    ]);
    const res = await GET(
      authedReq("http://test/api/sites/site_1/comments?filter=open"),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    const data = await res.json();
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].state).toBe("open");
  });
});

describe("POST /api/sites/[id]/comments", () => {
  it("posts an authed comment with via_share_token=false", async () => {
    const res = await POST(
      authedReq("http://test/api/sites/site_1/comments", {
        method: "POST",
        body: JSON.stringify({
          pageIndex: 0,
          sectionIndex: 1,
          sectionType: "hero",
          body: "Internal note.",
        }),
      }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockPostComment).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site_1",
        pageIndex: 0,
        sectionIndex: 1,
        actorEmail: "dev@wolfpack.agency",
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.comment_posted",
      "u_1",
      "dev",
      expect.objectContaining({ via_share_token: false }),
    );
  });

  it("fires comment_replied for a reply", async () => {
    await POST(
      authedReq("http://test/api/sites/site_1/comments", {
        method: "POST",
        body: JSON.stringify({
          pageIndex: 0,
          sectionIndex: 0,
          body: "Reply body",
          parentCommentId: "parent-xyz",
        }),
      }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.comment_replied",
      "u_1",
      "dev",
      expect.objectContaining({ parent_comment_id: "parent-xyz" }),
    );
  });

  it("400 on bad body", async () => {
    const res = await POST(
      authedReq("http://test/api/sites/site_1/comments", {
        method: "POST",
        body: JSON.stringify({ pageIndex: 0, sectionIndex: 0, body: "" }),
      }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /resolve", () => {
  it("200 when resolving a comment on the right site", async () => {
    const res = await RESOLVE_POST(
      authedReq("http://test/api/sites/site_1/comments/c1/resolve", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "site_1", commentId: "c1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({ commentId: "c1", userId: "u_1" });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.comment_resolved",
      "u_1",
      "dev",
      expect.objectContaining({ resolved_by_role: "dev" }),
    );
  });

  it("404 when the comment belongs to a different site (anti URL-rewrite)", async () => {
    mockGetComment.mockResolvedValueOnce({ ...GOOD_COMMENT, siteId: "other_site" });
    const res = await RESOLVE_POST(
      authedReq("http://test/api/sites/site_1/comments/c1/resolve", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "site_1", commentId: "c1" }) },
    );
    expect(res.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await RESOLVE_POST(
      new NextRequest("http://test/api/sites/site_1/comments/c1/resolve", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "site_1", commentId: "c1" }) },
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/sites/[id]/comments/[commentId]", () => {
  it("soft-deletes + fires analytics", async () => {
    const res = await DELETE_COMMENT(
      authedReq("http://test/api/sites/site_1/comments/c1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "site_1", commentId: "c1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({ commentId: "c1", userId: "u_1" });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.comment_deleted",
      "u_1",
      "dev",
      expect.objectContaining({ deleted_by_role: "dev" }),
    );
  });

  it("404 when the comment is on a different site", async () => {
    mockGetComment.mockResolvedValueOnce({ ...GOOD_COMMENT, siteId: "other_site" });
    const res = await DELETE_COMMENT(
      authedReq("http://test/api/sites/site_1/comments/c1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "site_1", commentId: "c1" }) },
    );
    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
