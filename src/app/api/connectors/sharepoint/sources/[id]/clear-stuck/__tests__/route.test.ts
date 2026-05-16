/**
 * clear-stuck route tests. Verifies workspace-scoped ownership check
 * + force-clear SQL + JSON 500 path.
 */

const mockGetUser = jest.fn();
const mockQuery = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/db", () => ({
  query: (...a: any[]) => mockQuery(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/connectors/sharepoint/sources/[id]/clear-stuck/route";

function req(): NextRequest {
  return new NextRequest(
    new Request("http://x/api/connectors/sharepoint/sources/abc/clear-stuck", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
    }),
  );
}
const ctx = { params: Promise.resolve({ id: "abc" }) };

beforeEach(() => {
  mockGetUser.mockReset();
  mockQuery.mockReset();
});

describe("POST /api/connectors/sharepoint/sources/[id]/clear-stuck", () => {
  test("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("404 when source doesn't belong to the user's workspace", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    /* First query (ownership check) returns no rows. */
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    /* Update query should NOT have been issued. */
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("happy path: scopes by workspace, marks running jobs failed, returns count", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    /* Ownership check passes. */
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "abc" }], rowCount: 1 });
    /* Update marks 2 stuck jobs. */
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(2);

    /* Ownership query is workspace-scoped. */
    expect(mockQuery.mock.calls[0][1]).toEqual(["abc", "ws1"]);
    /* Update query targets the source's running jobs only. */
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toMatch(/UPDATE instinct_sharepoint_ingest_jobs/);
    expect(updateSql).toMatch(/SET status = 'failed'/);
    expect(updateSql).toMatch(/WHERE source_id = \$1 AND status = 'running'/);
  });

  test("500 with JSON body when DB throws (NOT html)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockQuery.mockRejectedValue(new Error("pool_exhausted"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Clear failed/);
    expect(body.error).toMatch(/pool_exhausted/);
  });
});
