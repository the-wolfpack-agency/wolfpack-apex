/**
 * Sync route — async-acceptance contract tests.
 *
 * Verifies the route returns 202 immediately, kicks off the sync as a
 * background promise (so Vercel's 60-second function timeout doesn't
 * 504 the response), and returns JSON shapes on every error path.
 */

const mockGetUser = jest.fn();
const mockGetSource = jest.fn();
const mockStartJob = jest.fn();
const mockSyncSource = jest.fn();
const mockAfter = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/connectors/sharepoint/repo", () => ({
  createRepo: () => ({
    getSource: mockGetSource,
    startJob: mockStartJob,
  }),
}));
jest.mock("@/lib/connectors/sharepoint/sync", () => ({
  syncSource: (...a: any[]) => mockSyncSource(...a),
}));
/* Mock Next.js after() so we can capture the background callback +
 * verify it would invoke syncSource without actually awaiting it
 * during the request. */
jest.mock("next/server", () => {
  const actual = jest.requireActual("next/server");
  return {
    ...actual,
    after: (cb: () => void | Promise<void>) => mockAfter(cb),
  };
});

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
  mockStartJob.mockReset();
  mockSyncSource.mockReset();
  mockAfter.mockReset();
  /* Default: startJob returns a synthetic job row. Tests that need to
   * exercise startJob failure paths override this. */
  mockStartJob.mockResolvedValue({
    id: "job-xyz", sourceId: "abc", triggeredBy: "u1",
    startedAt: "2026-05-16T15:00:00Z", endedAt: null, status: "running",
    fileCount: 0, successCount: 0, failCount: 0, bytesIngested: 0, error: null,
  });
});

describe("POST /api/connectors/sharepoint/sources/[id]/sync", () => {
  test("returns 202 + jobId, creates job synchronously, schedules syncSource via after()", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    mockSyncSource.mockResolvedValue({ status: "succeeded" });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.sourceId).toBe("abc");
    /* jobId must be returned so the UI polls for THIS specific job
     * (no timestamp-comparison guessing). */
    expect(body.jobId).toBe("job-xyz");
    expect(mockStartJob).toHaveBeenCalledWith("abc", "u1");

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockSyncSource).not.toHaveBeenCalled();

    const afterCb = mockAfter.mock.calls[0][0] as () => Promise<void>;
    await afterCb();
    /* syncSource gets the pre-created jobId so it skips startJob inside. */
    expect(mockSyncSource).toHaveBeenCalledWith(
      activeSource, "u1", "cto",
      { existingJobId: "job-xyz" },
    );
  });

  test("401 unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  test("404 when source doesn't exist in workspace", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  test("410 when source is soft-deleted (isActive=false)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue({ ...activeSource, isActive: false });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(410);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  test("background syncSource failure is caught inside after() and doesn't surface to caller", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(activeSource);
    mockSyncSource.mockRejectedValue(new Error("boom"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(202);
    /* Invoke the after-callback. It must NOT throw — the try/catch
     * inside it logs and swallows so Vercel doesn't see a rejection. */
    const afterCb = mockAfter.mock.calls[0][0] as () => Promise<void>;
    await expect(afterCb()).resolves.toBeUndefined();
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
