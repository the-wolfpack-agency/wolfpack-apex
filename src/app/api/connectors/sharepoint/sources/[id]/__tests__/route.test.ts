/**
 * /sources/[id] route tests. Covers:
 *   - GET runs reconcileStuckJobs (so polling clears dead rows
 *     without a separate cron)
 *   - GET returns source + jobs list
 *   - DELETE soft-deletes via repo + fires analytics
 *   - All 401/404 + JSON-500 paths
 */

const mockGetUser = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetSource = jest.fn();
const mockListJobsForSource = jest.fn();
const mockDeactivateSource = jest.fn();
const mockReconcileStuckJobs = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/connectors/sharepoint/repo", () => ({
  createRepo: () => ({
    getSource: mockGetSource,
    listJobsForSource: mockListJobsForSource,
    deactivateSource: mockDeactivateSource,
    reconcileStuckJobs: mockReconcileStuckJobs,
  }),
}));

import { NextRequest } from "next/server";
import { GET, DELETE } from "@/app/api/connectors/sharepoint/sources/[id]/route";

function req(method: "GET" | "DELETE" = "GET"): NextRequest {
  return new NextRequest(
    new Request("http://x/api/connectors/sharepoint/sources/abc", {
      method,
      headers: { Authorization: "Bearer t" },
    }),
  );
}
const ctx = { params: Promise.resolve({ id: "abc" }) };

const fakeSource = {
  id: "abc", workspaceId: "ws1", name: "X", siteUrl: "u",
  siteId: "S", driveId: "D", folderPath: "F",
  createdBy: "u1", createdAt: "now", lastSyncedAt: null, isActive: true,
};

beforeEach(() => {
  mockGetUser.mockReset();
  mockTrackEvent.mockReset();
  mockGetSource.mockReset();
  mockListJobsForSource.mockReset();
  mockDeactivateSource.mockReset();
  mockReconcileStuckJobs.mockReset();
  mockReconcileStuckJobs.mockResolvedValue(0);
});

describe("GET /api/connectors/sharepoint/sources/[id]", () => {
  test("401 unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(401);
    expect(mockGetSource).not.toHaveBeenCalled();
  });

  test("404 when source not found in workspace", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(null);
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(404);
  });

  test("happy path: runs reconciler, returns source + recent jobs", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockResolvedValue(fakeSource);
    mockListJobsForSource.mockResolvedValue([{ id: "j1" }, { id: "j2" }]);
    mockReconcileStuckJobs.mockResolvedValue(1);

    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toEqual(fakeSource);
    expect(body.jobs).toHaveLength(2);

    /* CRITICAL: reconciler runs on every GET so stuck rows from
     * killed Vercel functions are cleaned up without a cron. */
    expect(mockReconcileStuckJobs).toHaveBeenCalledWith(6);
    /* Reconciler runs BEFORE listJobsForSource so jobs we return
     * reflect the post-reconcile state. */
    const reconcileCallOrder = mockReconcileStuckJobs.mock.invocationCallOrder[0];
    const listCallOrder = mockListJobsForSource.mock.invocationCallOrder[0];
    expect(reconcileCallOrder).toBeLessThan(listCallOrder);
  });

  test("500 JSON body when DB throws (not HTML)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockGetSource.mockRejectedValue(new Error("db_down"));
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/db_down/);
  });
});

describe("DELETE /api/connectors/sharepoint/sources/[id]", () => {
  test("401 unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(401);
    expect(mockDeactivateSource).not.toHaveBeenCalled();
  });

  test("404 when source doesn't exist in workspace", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockDeactivateSource.mockResolvedValue(false);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(404);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("happy path: deactivates + fires analytics", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockDeactivateSource.mockResolvedValue(true);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(mockDeactivateSource).toHaveBeenCalledWith("abc", "ws1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "connectors.sharepoint.source_removed", "u1", "cto",
      expect.objectContaining({ source_id: "abc", workspace_id: "ws1" }),
    );
  });

  test("500 JSON body when repo throws", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockDeactivateSource.mockRejectedValue(new Error("constraint_violation"));
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/constraint_violation/);
  });
});
