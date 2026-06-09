/**
 * Contract tests for /api/qr/[id] — the deletion-lock paths.
 *
 *   PATCH  { locked: true|false }  → toggles lock, emits analytics
 *   DELETE on a locked code        → 409 (archive refused), no archive
 *   DELETE on an unlocked code     → 200, archived
 *
 * `canArchive` is the real pure guard (jest.requireActual); the
 * DB-backed helpers are mocked.
 */

const mockGetCodeById = jest.fn();
const mockArchiveCode = jest.fn();
const mockSetLocked = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/qr/codes", () => {
  const actual = jest.requireActual("@/lib/qr/codes");
  return {
    ...actual, // keep the real canArchive guard
    getCodeById: (...a: any[]) => mockGetCodeById(...a),
    archiveCode: (...a: any[]) => mockArchiveCode(...a),
    setLocked: (...a: any[]) => mockSetLocked(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" }),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { PATCH, DELETE } from "../[id]/route";

const CODE_ID = "code-1";

function code(overrides: Record<string, unknown> = {}) {
  return {
    id: CODE_ID,
    slug: "abc1234",
    targetUrl: "https://x.test/page",
    label: "Spring brochure",
    utmCampaign: "spring",
    expiresAt: null,
    archivedAt: null,
    locked: false,
    createdAt: "2026-04-30T00:00:00.000Z",
    createdByUserId: "u1",
    createdByUserRole: "ceo",
    ...overrides,
  };
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest(`https://x.test/api/qr/${CODE_ID}`, {
    method: "PATCH",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function deleteReq(): NextRequest {
  return new NextRequest(`https://x.test/api/qr/${CODE_ID}`, {
    method: "DELETE",
    headers: { authorization: "Bearer x" },
  });
}
const ctx = { params: Promise.resolve({ id: CODE_ID }) };

beforeEach(() => {
  mockGetCodeById.mockReset();
  mockArchiveCode.mockReset();
  mockSetLocked.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

describe("PATCH /api/qr/[id] — lock toggle", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await PATCH(patchReq({ locked: true }), ctx);
    expect(res.status).toBe(401);
  });

  test("locking sets locked=true and emits qr.code_locked", async () => {
    mockSetLocked.mockResolvedValueOnce(code({ locked: true }));
    const res = await PATCH(patchReq({ locked: true }), ctx);
    expect(res.status).toBe(200);
    expect(mockSetLocked).toHaveBeenCalledWith(CODE_ID, true);
    const body = await res.json();
    expect(body.code.locked).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "qr.code_locked",
      "u1",
      "ceo",
      expect.objectContaining({ code_id: CODE_ID }),
    );
  });

  test("unlocking emits qr.code_unlocked", async () => {
    mockSetLocked.mockResolvedValueOnce(code({ locked: false }));
    const res = await PATCH(patchReq({ locked: false }), ctx);
    expect(res.status).toBe(200);
    expect(mockSetLocked).toHaveBeenCalledWith(CODE_ID, false);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "qr.code_unlocked",
      "u1",
      "ceo",
      expect.objectContaining({ code_id: CODE_ID }),
    );
  });
});

describe("DELETE /api/qr/[id] — lock-guarded archive", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(401);
  });

  test("404 when the code is missing", async () => {
    mockGetCodeById.mockResolvedValueOnce(null);
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(404);
    expect(mockArchiveCode).not.toHaveBeenCalled();
  });

  test("409 + no archive when the campaign is locked", async () => {
    mockGetCodeById.mockResolvedValueOnce(code({ locked: true }));
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("locked");
    expect(mockArchiveCode).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "qr.archive_blocked",
      "u1",
      "ceo",
      expect.objectContaining({ code_id: CODE_ID, reason: "locked" }),
    );
  });

  test("200 + archives when the campaign is unlocked", async () => {
    mockGetCodeById.mockResolvedValueOnce(code({ locked: false }));
    mockArchiveCode.mockResolvedValueOnce(code({ archivedAt: "2026-06-09T00:00:00.000Z" }));
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(200);
    expect(mockArchiveCode).toHaveBeenCalledWith(CODE_ID);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
