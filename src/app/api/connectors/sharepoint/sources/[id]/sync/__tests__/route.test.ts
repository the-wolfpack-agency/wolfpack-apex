/**
 * Sync route — synchronous contract tests.
 *
 * The route awaits syncSource() before responding. Verifies:
 *   - 200 + result on success
 *   - 200 on partial (some files failed but the sync completed)
 *   - 502 when status='failed'
 *   - 401 / 404 / 410 auth/lookup paths
 *   - 500 + JSON body when a non-syncSource error escapes
 */

const mockGetUser = jest.fn();
const mockGetSource = jest.fn();
const mockSyncSource = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/connectors/sharepoint/repo", () => ({
  createRepo: () => ({
    getSource: mockGetSource,
  }),
}));
jest.mock("@/lib/connectors/sharepoint/sync", () => ({
  syncSource: (...a: any[]) => mockSyncSource(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/connectors/sharepoint/sources/[id]/sync/route";

function req(): NextRequest {
  return new NextRequest(
    new Request("http://x/api/connectors/sharepoint/sources/abc/sync", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
    }),
  );
}
const ctx = { params: Promise.resolve({ id: "abc" }) };

const activeSource = {
  id: "abc", workspaceId: "ws1", name: "X", siteUrl: "u",
  siteId: "S", driveId: "D", folderPath: "F",
  createdBy: "u1", createdAt: "now", lastSyncedAt: null, isActive: true,
};

beforeEach(() => {
  mockGetUser.mockReset();
  mockGetSource.mockReset();
  mockSyncSource.mockReset();
});

describe("POST /api/connectors/sharepoint/sources/[id]/sync", () => {
  test("200 + result when sync succeeds", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    mockSyncSource.mockResolvedValue({
      jobId: "j1", status: "succeeded",
      fileCount: 3, successCount: 3, failCount: 0, bytesIngested: 1024, error: null,
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.status).toBe("succeeded");
    expect(body.result.fileCount).toBe(3);
  });

  test("200 + status=partial when some files failed", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    mockSyncSource.mockResolvedValue({
      jobId: "j2", status: "partial",
      fileCount: 5, successCount: 3, failCount: 2, bytesIngested: 800, error: null,
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.status).toBe("partial");
  });

  test("502 when status=failed (whole sync didn't complete)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    mockSyncSource.mockResolvedValue({
      jobId: "j3", status: "failed",
      fileCount: 0, successCount: 0, failCount: 0, bytesIngested: 0, error: "no_token",
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.result.error).toBe("no_token");
  });

  test("401 unauthenticated, syncSource never called", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(mockSyncSource).not.toHaveBeenCalled();
  });

  test("404 when source missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(mockSyncSource).not.toHaveBeenCalled();
  });

  test("410 when source is soft-deleted", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue({ ...activeSource, isActive: false });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(410);
    expect(mockSyncSource).not.toHaveBeenCalled();
  });

  test("500 JSON when a pre-sync error throws (not HTML)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockRejectedValue(new Error("db_down"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Sync failed unexpectedly/);
    expect(body.error).toMatch(/db_down/);
  });
});
