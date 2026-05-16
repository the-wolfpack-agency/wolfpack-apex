/**
 * Sync route — async-acceptance contract tests.
 *
 * Verifies the route returns 202 immediately, kicks off the sync as a
 * background promise (so Vercel's 60-second function timeout doesn't
 * 504 the response), and returns JSON shapes on every error path.
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
  test("returns 202 immediately, fires syncSource as void promise", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    /* Block syncSource so we can confirm the route returned BEFORE it
     * resolves. The route must not await syncSource. */
    let releaseSync: (() => void) | null = null;
    mockSyncSource.mockImplementation(
      () => new Promise((resolve) => { releaseSync = resolve; }),
    );

    const res = await POST(req(), ctx);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.sourceId).toBe("abc");
    expect(mockSyncSource).toHaveBeenCalledWith(activeSource, "u1", "cto");
    /* Release the background promise so the test doesn't leak it. */
    releaseSync?.();
  });

  test("401 unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(mockSyncSource).not.toHaveBeenCalled();
  });

  test("404 when source doesn't exist in workspace", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(mockSyncSource).not.toHaveBeenCalled();
  });

  test("410 when source is soft-deleted (isActive=false)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue({ ...activeSource, isActive: false });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(410);
    expect(mockSyncSource).not.toHaveBeenCalled();
  });

  test("background syncSource failure is logged but doesn't surface to caller", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    /* The background promise rejecting must NOT change the 202
     * response. The route's .catch attaches a logger; the caller is
     * unaffected (status is polled via GET /sources/[id]). */
    mockSyncSource.mockRejectedValue(new Error("boom"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(202);
  });

  test("uncaught error before 202 returns JSON 500 (not HTML)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockRejectedValue(new Error("db_down"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Sync failed unexpectedly/);
    expect(body.error).toMatch(/db_down/);
  });
});
