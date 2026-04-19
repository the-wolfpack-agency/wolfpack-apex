/**
 * /api/public/share/[token]/comments route tests.
 *
 * Verifies the PUBLIC (unauth) comments endpoint:
 *   - cryptographic verification of the signed blob
 *   - DB revocation / site-mismatch check
 *   - body validation (empty / oversize / bad indices)
 *   - rate-limit trip at 21st post
 *   - analytics firing with via_share_token=true
 *   - noindex headers on every response path (error + success)
 *   - reply path fires site.comment_replied
 */

const mockVerify = jest.fn();
const mockLoad = jest.fn();
const mockTouch = jest.fn();
jest.mock("@/lib/share-tokens", () => ({
  verifyShareToken: (...args: unknown[]) => mockVerify(...args),
  loadActiveTokenRow: (...args: unknown[]) => mockLoad(...args),
  touchShareTokenAccess: (...args: unknown[]) => mockTouch(...args),
  getShareSecret: () => "test-secret",
}));

const mockPost = jest.fn();
const mockList = jest.fn();

class CommentValidationErrorMock extends Error {
  code: string;
  constructor(msg: string, code: string) {
    super(msg);
    this.name = "CommentValidationError";
    this.code = code;
  }
}

jest.mock("@/lib/section-comments", () => ({
  postComment: (...args: unknown[]) => mockPost(...args),
  listCommentsForSite: (...args: unknown[]) => mockList(...args),
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
import {
  POST,
  GET,
  __resetRateLimitForTests,
} from "@/app/api/public/share/[token]/comments/route";

function postReq(body: unknown) {
  return new NextRequest("http://test/api/public/share/tok/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD_CLAIMS = { siteId: "site_1", nonce: "nonce-1", exp: 9_999_999_999 };
const GOOD_ROW = {
  id: "tok-row-1",
  site_id: "site_1",
  nonce: "nonce-1",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  revoked_at: null,
  access_count: 2,
};

const GOOD_COMMENT = {
  id: "c1",
  siteId: "site_1",
  shareTokenId: "tok-row-1",
  pageIndex: 0,
  sectionIndex: 1,
  sectionType: "hero",
  body: "Looks great",
  actorName: "Client",
  actorEmail: "c@example.com",
  parentCommentId: null,
  state: "open" as const,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-04-19T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetRateLimitForTests();
  mockVerify.mockReturnValue({ ok: true, claims: GOOD_CLAIMS });
  mockLoad.mockResolvedValue(GOOD_ROW);
  mockPost.mockResolvedValue(GOOD_COMMENT);
  mockList.mockResolvedValue([GOOD_COMMENT]);
});

describe("POST — happy paths", () => {
  it("posts a comment, fires site.comment_posted, returns 200 + noindex", async () => {
    const res = await POST(
      postReq({
        pageIndex: 0,
        sectionIndex: 1,
        sectionType: "hero",
        body: "Looks great",
        actorName: "Client",
        actorEmail: "c@example.com",
      }),
      { params: Promise.resolve({ token: "tok" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(mockPost).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site_1",
        shareTokenId: "tok-row-1",
        pageIndex: 0,
        sectionIndex: 1,
        body: "Looks great",
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.comment_posted",
      "public",
      "client",
      expect.objectContaining({ via_share_token: true, body_length: 11 }),
    );
    expect(mockTouch).toHaveBeenCalledWith("tok-row-1");
  });

  it("fires site.comment_replied when parentCommentId is present", async () => {
    await POST(
      postReq({
        pageIndex: 0,
        sectionIndex: 0,
        body: "Thanks!",
        parentCommentId: "parent-1",
      }),
      { params: Promise.resolve({ token: "tok" }) },
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.comment_replied",
      "public",
      "client",
      expect.objectContaining({ parent_comment_id: "parent-1" }),
    );
  });
});

describe("POST — rejections", () => {
  it("401 when the token signature is bad", async () => {
    mockVerify.mockReturnValueOnce({ ok: false, reason: "bad_signature" });
    const res = await POST(postReq({ pageIndex: 0, sectionIndex: 0, body: "hi" }), {
      params: Promise.resolve({ token: "bogus" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("401 when the nonce has been revoked / is unknown", async () => {
    mockLoad.mockResolvedValueOnce(null);
    const res = await POST(postReq({ pageIndex: 0, sectionIndex: 0, body: "hi" }), {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(401);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("401 when the claim siteId does not match the DB row (anti-replay)", async () => {
    mockLoad.mockResolvedValueOnce({ ...GOOD_ROW, site_id: "other_site" });
    const res = await POST(postReq({ pageIndex: 0, sectionIndex: 0, body: "hi" }), {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 on empty body", async () => {
    const res = await POST(postReq({ pageIndex: 0, sectionIndex: 0, body: "" }), {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("400 on body > 5000 chars (lib throws CommentValidationError)", async () => {
    mockPost.mockRejectedValueOnce(
      new CommentValidationErrorMock("body too long", "body_too_long"),
    );
    const res = await POST(
      postReq({
        pageIndex: 0,
        sectionIndex: 0,
        body: "x".repeat(5001),
      }),
      { params: Promise.resolve({ token: "tok" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 on bad pageIndex (negative)", async () => {
    const res = await POST(
      postReq({ pageIndex: -1, sectionIndex: 0, body: "hi" }),
      { params: Promise.resolve({ token: "tok" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON", async () => {
    const req = new NextRequest("http://test/api/public/share/tok/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req, { params: Promise.resolve({ token: "tok" }) });
    expect(res.status).toBe(400);
  });
});

describe("POST — rate limiting", () => {
  it("allows 20 then 429s the 21st for the same nonce", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await POST(
        postReq({ pageIndex: 0, sectionIndex: 0, body: `msg ${i}` }),
        { params: Promise.resolve({ token: "tok" }) },
      );
      expect(res.status).toBe(200);
    }
    const res21 = await POST(
      postReq({ pageIndex: 0, sectionIndex: 0, body: "one too many" }),
      { params: Promise.resolve({ token: "tok" }) },
    );
    expect(res21.status).toBe(429);
    expect(res21.headers.get("retry-after")).toBeTruthy();
    expect(res21.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("different nonces have independent buckets", async () => {
    for (let i = 0; i < 20; i++) {
      await POST(postReq({ pageIndex: 0, sectionIndex: 0, body: `m${i}` }), {
        params: Promise.resolve({ token: "tok-a" }),
      });
    }
    mockVerify.mockReturnValueOnce({
      ok: true,
      claims: { ...GOOD_CLAIMS, nonce: "nonce-b" },
    });
    mockLoad.mockResolvedValueOnce({ ...GOOD_ROW, nonce: "nonce-b" });
    const res = await POST(postReq({ pageIndex: 0, sectionIndex: 0, body: "b" }), {
      params: Promise.resolve({ token: "tok-b" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET — happy path + auth", () => {
  it("returns open comments + noindex header", async () => {
    const req = new NextRequest("http://test/api/public/share/tok/comments");
    const res = await GET(req, { params: Promise.resolve({ token: "tok" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    const data = await res.json();
    expect(Array.isArray(data.comments)).toBe(true);
    expect(mockList).toHaveBeenCalledWith("site_1", { openOnly: true });
  });

  it("401 on invalid token", async () => {
    mockVerify.mockReturnValueOnce({ ok: false, reason: "malformed" });
    const req = new NextRequest("http://test/api/public/share/bad/comments");
    const res = await GET(req, { params: Promise.resolve({ token: "bad" }) });
    expect(res.status).toBe(401);
  });
});
