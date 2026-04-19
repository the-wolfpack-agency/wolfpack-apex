/**
 * /api/sites/[id]/versions route tests.
 *
 * Mirrors the brief-edit-route.test.ts pattern: jest.mock all deps,
 * call the route handler directly with a NextRequest, and inspect the
 * NextResponse + mock call shapes.
 */

const mockGetUser = jest.fn();
const mockHasRole = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  hasRole: (...args: unknown[]) => mockHasRole(...args),
}));

const mockGetSite = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...args: unknown[]) => mockGetSite(...args),
}));

const mockList = jest.fn();
const mockRestore = jest.fn();
class FakeRestoreError extends Error {
  reason: "version_not_found" | "site_not_found" | "write_failed";
  constructor(
    msg: string,
    reason: "version_not_found" | "site_not_found" | "write_failed",
  ) {
    super(msg);
    this.name = "RestoreVersionError";
    this.reason = reason;
  }
}
jest.mock("@/lib/brief-versions", () => ({
  listVersionsForSite: (...args: unknown[]) => mockList(...args),
  restoreVersion: (...args: unknown[]) => mockRestore(...args),
  RestoreVersionError: FakeRestoreError,
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

class MockWriteQueryError extends Error {
  readonly code: "no_database" | "db_error" | "unexpected_row_count";
  constructor(
    msg: string,
    code: "no_database" | "db_error" | "unexpected_row_count",
  ) {
    super(msg);
    this.name = "WriteQueryError";
    this.code = code;
  }
}
jest.mock("@/lib/db", () => ({
  WriteQueryError: MockWriteQueryError,
}));

import { NextRequest } from "next/server";
import {
  GET as versionsGET,
  POST as versionsPOST,
} from "@/app/api/sites/[id]/versions/route";

function req(method: string, body?: unknown, opts: { auth?: string } = {}) {
  return new NextRequest("http://test/api/sites/site_1/versions", {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasRole.mockReturnValue(true);
});

/* ----------------------------- GET ----------------------------------- */

describe("GET /api/sites/[id]/versions", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await versionsGET(req("GET"), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("403 when the site is not found (ownership / visibility)", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce(null);
    const res = await versionsGET(req("GET", undefined, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_unknown" }),
    });
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("200 returns the sorted version list", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({
      id: "site_1",
      brief: { client: "x", product: { name: "X" }, pages: [] },
    });
    mockList.mockResolvedValueOnce([
      { id: "edit_e1", kind: "prompt_edit", siteId: "site_1" },
      { id: "gen_g1", kind: "ai_extraction", siteId: "site_1" },
    ]);

    const res = await versionsGET(
      req("GET", undefined, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.versions).toHaveLength(2);
    expect(data.versions[0].id).toBe("edit_e1");
  });

  it("fires site.version_history_viewed on success", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockList.mockResolvedValueOnce([{ id: "edit_e1" }, { id: "gen_g1" }]);

    await versionsGET(req("GET", undefined, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.version_history_viewed",
      "u_1",
      "sales",
      expect.objectContaining({ site_id: "site_1", version_count: 2 }),
    );
  });
});

/* ----------------------------- POST restore -------------------------- */

describe("POST /api/sites/[id]/versions (restore)", () => {
  const STUB_ENTRY = {
    id: "edit_new",
    kind: "restore",
    siteId: "site_1",
    brief: { client: "x", product: { name: "X" }, pages: [] },
    authorId: "u_1",
    authorRole: "sales",
    summary: "Restored",
    createdAt: "2026-04-19T10:00:00Z",
    parentVersionId: "edit_old",
  };

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await versionsPOST(
      req("POST", { action: "restore", toVersionId: "edit_e1" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("403 when role is below sales", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockHasRole.mockReturnValueOnce(false);
    const res = await versionsPOST(
      req(
        "POST",
        { action: "restore", toVersionId: "edit_e1" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("400 when action is not 'restore'", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await versionsPOST(
      req("POST", { action: "delete" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 when toVersionId missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await versionsPOST(
      req("POST", { action: "restore" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const bad = new NextRequest("http://test/api/sites/site_1/versions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
      },
      body: "{ broken",
    });
    const res = await versionsPOST(bad, {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(400);
  });

  it("403 when the site is not found / not owned", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce(null);
    const res = await versionsPOST(
      req(
        "POST",
        { action: "restore", toVersionId: "edit_e1" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("404 when toVersionId doesn't match a known version", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockRestore.mockRejectedValueOnce(
      new FakeRestoreError("missing", "version_not_found"),
    );
    const res = await versionsPOST(
      req(
        "POST",
        { action: "restore", toVersionId: "edit_nope" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.reason).toBe("version_not_found");
  });

  it("200 calls the lib with correct args and returns the new entry", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockRestore.mockResolvedValueOnce(STUB_ENTRY);

    const res = await versionsPOST(
      req(
        "POST",
        { action: "restore", toVersionId: "edit_old" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version.id).toBe("edit_new");
    expect(mockRestore).toHaveBeenCalledWith({
      siteId: "site_1",
      toVersionId: "edit_old",
      userId: "u_1",
      userRole: "sales",
    });
  });

  it("500 with reason=unexpected_row_count when writeQuery fails (no silent discard)", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockRestore.mockRejectedValueOnce(
      new MockWriteQueryError("boom", "unexpected_row_count"),
    );
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await versionsPOST(
      req(
        "POST",
        { action: "restore", toVersionId: "edit_x" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.reason).toBe("unexpected_row_count");
    errSpy.mockRestore();
  });

  it("500 on unexpected error", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockRestore.mockRejectedValueOnce(new Error("kaboom"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await versionsPOST(
      req(
        "POST",
        { action: "restore", toVersionId: "edit_x" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});
