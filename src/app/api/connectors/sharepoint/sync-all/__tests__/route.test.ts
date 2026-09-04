/**
 * sync-all route — contract tests.
 *
 * Verifies the auth surface and status mapping without touching Graph/DB:
 *   - 401 unauthenticated
 *   - 403 authenticated but not admin (estate sync is an operator action)
 *   - 200 + result on success (incl. partial estate progress)
 *   - 502 only when every processed source failed
 *   - 500 + JSON body when an unexpected error escapes
 */

const mockRequireCap = jest.fn();
const mockSyncAll = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));
jest.mock("@/lib/connectors/sharepoint/sync-all", () => ({
  syncAllSources: (...a: any[]) => mockSyncAll(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/connectors/sharepoint/sync-all/route";

/** requireCapability resolves to {ok:true,user} or {ok:false,response}. */
function allow(user: Record<string, unknown>) {
  return { ok: true, user };
}
function deny(status: number) {
  return { ok: false, response: NextResponse.json({ error: "x" }, { status }) };
}

function req(): NextRequest {
  return new NextRequest(
    new Request("http://x/api/connectors/sharepoint/sync-all", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
    }),
  );
}

function result(over: Partial<Record<string, unknown>> = {}) {
  return {
    sourcesTotal: 2, sourcesProcessed: 2, sourcesSucceeded: 2, sourcesFailed: 0,
    filesIngested: 5, sources: [], moreRemaining: false, ...over,
  };
}

beforeEach(() => {
  mockRequireCap.mockReset();
  mockSyncAll.mockReset();
});

describe("POST /api/connectors/sharepoint/sync-all", () => {
  test("401 when unauthenticated (requireCapability denies)", async () => {
    mockRequireCap.mockResolvedValue(deny(401));
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mockSyncAll).not.toHaveBeenCalled();
  });

  test("403 when missing the manage-team capability", async () => {
    mockRequireCap.mockResolvedValue(deny(403));
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(mockSyncAll).not.toHaveBeenCalled(); // never even starts the sync
  });

  test("requires the settings.manage_team capability", async () => {
    mockRequireCap.mockResolvedValue(allow({ id: "u1", role: "cto", workspaceId: "ws1" }));
    mockSyncAll.mockResolvedValue(result());
    await POST(req());
    expect(mockRequireCap).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });

  test("200 + result for a permitted operator on success", async () => {
    mockRequireCap.mockResolvedValue(allow({ id: "u1", role: "cto", workspaceId: "ws1" }));
    mockSyncAll.mockResolvedValue(result());
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.filesIngested).toBe(5);
    // workspace comes from the session, never the request.
    expect(mockSyncAll).toHaveBeenCalledWith("ws1", "u1", "cto");
  });

  test("200 on partial estate progress (some sources failed)", async () => {
    mockRequireCap.mockResolvedValue(allow({ id: "u1", role: "cto", workspaceId: "ws1" }));
    mockSyncAll.mockResolvedValue(result({ sourcesSucceeded: 1, sourcesFailed: 1 }));
    const res = await POST(req());
    expect(res.status).toBe(200);
  });

  test("502 only when every processed source failed", async () => {
    mockRequireCap.mockResolvedValue(allow({ id: "u1", role: "cto", workspaceId: "ws1" }));
    mockSyncAll.mockResolvedValue(
      result({ sourcesProcessed: 2, sourcesSucceeded: 0, sourcesFailed: 2 }),
    );
    const res = await POST(req());
    expect(res.status).toBe(502);
  });

  test("500 + JSON body when the sync throws unexpectedly", async () => {
    mockRequireCap.mockResolvedValue(allow({ id: "u1", role: "cto", workspaceId: "ws1" }));
    mockSyncAll.mockRejectedValue(new Error("boom"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("boom");
  });
});
