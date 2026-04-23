/**
 * PUT / DELETE /api/discussions/[id]/comments/[commentId] — unit tests.
 */

const mockGetUserFromRequest = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
}));

const mockHasCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
}));

const mockGetReply = jest.fn();
const mockUpdateReply = jest.fn();
const mockDeleteReply = jest.fn();
jest.mock("@/lib/discussions", () => ({
  getReply: (...args: unknown[]) => mockGetReply(...args),
  updateReply: (...args: unknown[]) => mockUpdateReply(...args),
  deleteReply: (...args: unknown[]) => mockDeleteReply(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
  extractRequestMetadata: () => ({}),
}));

import { NextRequest } from "next/server";
import {
  PUT,
  DELETE,
} from "@/app/api/discussions/[id]/comments/[commentId]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/discussions/d-1/comments/r-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const AUTHOR = { id: "u-author", role: "dev", name: "A", email: "a@e" };
const STRANGER = { id: "u-stranger", role: "sales", name: "S", email: "s@e" };

const REPLY = {
  id: "r-1",
  discussion_id: "d-1",
  author_id: "u-author",
  content: "Original",
  attachments: [],
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "a-1", seq: 1, entryHash: "h" });
  mockHasCapability.mockReturnValue(false);
});

describe("PUT comment", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await PUT(req("PUT", { content: "X" }), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when reply doesn't belong to the discussion", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(AUTHOR);
    mockGetReply.mockResolvedValueOnce({ ...REPLY, discussion_id: "other" });
    const res = await PUT(req("PUT", { content: "X" }), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-author without capability", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(STRANGER);
    mockGetReply.mockResolvedValueOnce(REPLY);
    mockHasCapability.mockReturnValueOnce(false);
    const res = await PUT(req("PUT", { content: "X" }), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("400 when content is empty", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(AUTHOR);
    mockGetReply.mockResolvedValueOnce(REPLY);
    const res = await PUT(req("PUT", { content: "   " }), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 happy path as author + audits", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(AUTHOR);
    mockGetReply.mockResolvedValueOnce(REPLY);
    mockUpdateReply.mockResolvedValueOnce({ ...REPLY, content: "New" });

    const res = await PUT(req("PUT", { content: "New" }), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reply: { content: string } };
    expect(body.ok).toBe(true);
    expect(body.reply.content).toBe("New");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussions.comment.edited",
        resourceId: "r-1",
      }),
    );
  });
});

describe("DELETE comment", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 when non-author", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(STRANGER);
    mockGetReply.mockResolvedValueOnce(REPLY);
    mockHasCapability.mockReturnValueOnce(false);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("200 happy path as author + audits", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(AUTHOR);
    mockGetReply.mockResolvedValueOnce(REPLY);
    mockDeleteReply.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "d-1", commentId: "r-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("r-1");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussions.comment.deleted",
      }),
    );
  });
});
