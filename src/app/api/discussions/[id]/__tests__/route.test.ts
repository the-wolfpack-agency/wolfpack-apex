/**
 * PUT / DELETE /api/discussions/[id] — unit tests.
 *
 * Mirrors src/app/api/knowledge/[id]/__tests__/route.test.ts. Server deps
 * are mocked; handlers imported directly; responses inspected. Covers
 * auth (401/403), 404, validation (400) and 200 happy paths plus the
 * audit-log fanout.
 */

const mockGetUserFromRequest = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
}));

const mockHasCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
}));

const mockGetThread = jest.fn();
const mockUpdateDiscussion = jest.fn();
const mockDeleteDiscussion = jest.fn();
const mockReplyToThread = jest.fn();
jest.mock("@/lib/discussions", () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
  updateDiscussion: (...args: unknown[]) => mockUpdateDiscussion(...args),
  deleteDiscussion: (...args: unknown[]) => mockDeleteDiscussion(...args),
  replyToThread: (...args: unknown[]) => mockReplyToThread(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
  extractRequestMetadata: () => ({}),
}));

import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/discussions/[id]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/discussions/d-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const OWNER = { id: "u-owner", role: "dev", name: "O", email: "o@e" };
const STRANGER = { id: "u-stranger", role: "sales", name: "S", email: "s@e" };

const THREAD = {
  discussion: {
    id: "d-1",
    title: "Hello",
    category: "general",
    created_by: "u-owner",
    status: "open",
    pinned: false,
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  replies: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "a-1", seq: 1, entryHash: "h" });
  mockHasCapability.mockReturnValue(false);
});

describe("PUT /api/discussions/[id]", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await PUT(req("PUT", { title: "X" }), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockUpdateDiscussion).not.toHaveBeenCalled();
  });

  it("404 when missing", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetThread.mockResolvedValueOnce(null);
    const res = await PUT(req("PUT", { title: "X" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-owner without capability", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(STRANGER);
    mockGetThread.mockResolvedValueOnce(THREAD);
    mockHasCapability.mockReturnValueOnce(false);
    const res = await PUT(req("PUT", { title: "X" }), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("400 when no editable field supplied", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetThread.mockResolvedValueOnce(THREAD);
    const res = await PUT(req("PUT", {}), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 happy path as owner + audits", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetThread.mockResolvedValueOnce(THREAD);
    mockUpdateDiscussion.mockResolvedValueOnce({
      ...THREAD.discussion,
      title: "New title",
    });

    const res = await PUT(req("PUT", { title: "New title" }), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; discussion: { title: string } };
    expect(body.ok).toBe(true);
    expect(body.discussion.title).toBe("New title");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussions.discussion.edited",
        resourceId: "d-1",
      }),
    );
  });
});

describe("DELETE /api/discussions/[id]", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 when non-owner without capability", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(STRANGER);
    mockGetThread.mockResolvedValueOnce(THREAD);
    mockHasCapability.mockReturnValueOnce(false);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("200 happy path as owner + audits", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetThread.mockResolvedValueOnce(THREAD);
    mockDeleteDiscussion.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "d-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("d-1");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussions.discussion.deleted",
      }),
    );
  });
});
