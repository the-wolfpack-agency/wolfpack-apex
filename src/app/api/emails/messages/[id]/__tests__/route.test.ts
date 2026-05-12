 
/**
 * /api/emails/[id] PATCH + DELETE — contract test.
 *
 * Locks the inbox-action surface (mark read/unread, archive, delete).
 */

const mockGetUser = jest.fn();
const mockRequireCapability = jest.fn();
const mockSetReadState = jest.fn();
const mockArchive = jest.fn();
const mockDelete = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/integrations/microsoft-mail", () => ({
  setMessageReadState: (...a: any[]) => mockSetReadState(...a),
  archiveMessage: (...a: any[]) => mockArchive(...a),
  deleteMessage: (...a: any[]) => mockDelete(...a),
}));

import { NextRequest } from "next/server";
import { PATCH, DELETE } from "../route";
import { _resetRateLimit } from "../../../inbox/route";

function makePatch(id: string, body: unknown, withAuth = true): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withAuth) headers.authorization = "Bearer test-token";
  return new NextRequest(`https://x.test/api/emails/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}
function makeDelete(id: string, withAuth = true): NextRequest {
  const headers: Record<string, string> = {};
  if (withAuth) headers.authorization = "Bearer test-token";
  return new NextRequest(`https://x.test/api/emails/${id}`, {
    method: "DELETE",
    headers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
  mockGetUser.mockReturnValue({ id: "u1", role: "ceo" });
  mockRequireCapability.mockResolvedValue({
    ok: true,
    user: { id: "u1", role: "ceo" },
    capabilities: new Set(["emails.view"]),
  });
});

describe("PATCH /api/emails/[id]", () => {
  it("returns 401 with no auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await PATCH(makePatch("x", { isRead: true }, false), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 on empty id", async () => {
    const res = await PATCH(makePatch("   ", { isRead: true }), {
      params: Promise.resolve({ id: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("400 when neither isRead nor archive provided", async () => {
    const res = await PATCH(makePatch("x", {}), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(400);
  });

  it("flips isRead via setMessageReadState", async () => {
    mockSetReadState.mockResolvedValueOnce({ ok: true, value: { id: "x", isRead: false } });
    const res = await PATCH(makePatch("x", { isRead: false }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "x", isRead: false });
    expect(mockSetReadState).toHaveBeenCalledWith("u1", "x", false);
  });

  it("archives via archiveMessage and returns the new id", async () => {
    mockArchive.mockResolvedValueOnce({ ok: true, value: { id: "new-id" } });
    const res = await PATCH(makePatch("x", { archive: true }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "new-id", archived: true });
  });

  it("returns 403 scope_missing", async () => {
    mockSetReadState.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Mail.ReadWrite",
      status: 403,
    });
    const res = await PATCH(makePatch("x", { isRead: true }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
  });

  it("returns 404 not_found when Graph rejects the id", async () => {
    mockSetReadState.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 404,
      message: "not_found",
    });
    const res = await PATCH(makePatch("x", { isRead: true }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 502 on graph 5xx — never 500", async () => {
    mockSetReadState.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 500,
      message: "boom",
    });
    const res = await PATCH(makePatch("x", { isRead: true }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(502);
  });
});

describe("DELETE /api/emails/[id]", () => {
  it("401 with no auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await DELETE(makeDelete("x", false), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("200 happy path", async () => {
    mockDelete.mockResolvedValueOnce({ ok: true, value: { id: "x" } });
    const res = await DELETE(makeDelete("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "x", deleted: true });
  });

  it("404 when graph not_found", async () => {
    mockDelete.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 404,
      message: "not_found",
    });
    const res = await DELETE(makeDelete("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(404);
  });

  it("forwards Mail.ReadWrite-scoped 403 from Graph as a structured scope_missing error", async () => {
    // Reproduces the "Couldn't delete: request_failed_403" production
    // bug: the OAuth consent set never included Mail.ReadWrite, so
    // Graph returned 403 ErrorAccessDenied. The route layer must
    // surface this as a typed code so the UI can render a reconnect
    // CTA instead of the raw 403.
    mockDelete.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Mail.ReadWrite",
      status: 403,
    });
    const res = await DELETE(makeDelete("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
    expect(body.code).toBe("scope_missing");
    expect(body.scope).toBe("Mail.ReadWrite");
  });

  it("defaults the scope_missing scope to Mail.ReadWrite if Graph omitted it", async () => {
    mockDelete.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      // scope omitted by lib — route should fall back.
      status: 403,
    });
    const res = await DELETE(makeDelete("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.scope).toBe("Mail.ReadWrite");
  });
});
