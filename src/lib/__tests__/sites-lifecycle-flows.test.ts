/**
 * Sites LIFECYCLE flows — create, list, read, archive, hard-delete state machine.
 *
 * Scope: the HTTP boundary of every route in `/api/sites` + `/api/sites/[id]`
 * that participates in lifecycle state transitions. Each test asserts the
 * HTTP status, the response JSON shape the UI consumes, and — when applicable
 * — the audit-log call shape so nothing about a lifecycle transition can be
 * silently dropped from the learning loop.
 *
 * Follows the `sites-delete.test.ts` mocking pattern exactly:
 *   - `@/lib/auth` is mocked with a stub `getUserFromRequest` + real-shaped
 *     `hasRole` helper (levels: ceo/cto 5, hr 4, dev 3, ops 2, sales 1).
 *   - `@/lib/sites` is mocked so we exercise route logic in isolation — we
 *     do NOT re-test the library's internal validation/DB behaviour here.
 *   - `@/lib/audit-log` is mocked; assertions on `action` + `resourceType` +
 *     `afterState` ride on the same structure `sites-delete.test.ts` uses.
 *
 * Overlap note: the soft-archive happy path (`DELETE /api/sites/[id]` with
 * no `?hard=true`) is already covered in `sites-delete.test.ts` and is NOT
 * duplicated here. The hard-delete matrix + the rest of the lifecycle
 * state machine IS covered here.
 */

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
  hasRole: (role: string, required: string) => {
    const levels: Record<string, number> = { ceo: 5, cto: 5, hr: 4, dev: 3, ops: 2, sales: 1 };
    return (levels[role] ?? 0) >= (levels[required] ?? 0);
  },
}));

const mockCreate = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDeploy = jest.fn();
const mockDelete = jest.fn();

class FakeBriefError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super("brief invalid: " + errors.join(", "));
    this.name = "BriefValidationError";
    this.errors = errors;
  }
}

jest.mock("@/lib/sites", () => ({
  createSiteProject: (...a: unknown[]) => mockCreate(...a),
  listSiteProjects: (...a: unknown[]) => mockList(...a),
  getSiteProject: (...a: unknown[]) => mockGet(...a),
  updateBrief: (...a: unknown[]) => mockUpdate(...a),
  triggerDeploy: (...a: unknown[]) => mockDeploy(...a),
  deleteSiteProject: (...a: unknown[]) => mockDelete(...a),
  BriefValidationError: FakeBriefError,
}));

const mockAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({
    ipAddress: "127.0.0.1",
    userAgent: "jest",
    requestId: "req-lifecycle",
  }),
}));

import { getUserFromRequest } from "@/lib/auth";
import { NextRequest } from "next/server";
import { GET as listGET, POST as listPOST } from "@/app/api/sites/route";
import { GET as detailGET, DELETE as detailDELETE } from "@/app/api/sites/[id]/route";

const mockGetUser = getUserFromRequest as jest.MockedFunction<typeof getUserFromRequest>;

/** Matches the structure of `TeamMember` used by the route handlers. */
const CTO_USER = {
  id: "u_cto",
  email: "cto@test",
  name: "CTO",
  role: "cto" as const,
  created_at: "",
};
const HR_USER = { ...CTO_USER, id: "u_hr", role: "hr" as const };
const SALES_USER = { ...CTO_USER, id: "u_sales", role: "sales" as const };

/** Bare minimum brief that `createSiteProject` would accept after validation. */
const VALID_BRIEF = {
  client: "acme",
  product: { name: "Acme Industries" },
  pages: [{ route: "/", sections: [] }],
};

function jsonReq(url: string, method: "GET" | "POST" | "DELETE", opts: { auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.body !== undefined) {
    return new NextRequest(url, { method, headers, body: JSON.stringify(opts.body) });
  }
  return new NextRequest(url, { method, headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

/* ========================================================================== *
 * 1. LIST flow — GET /api/sites
 * ========================================================================== */

describe("sites lifecycle — list flow (GET /api/sites)", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await listGET(jsonReq("http://t/api/sites", "GET"));
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  test("200 returns projects array shaped for the UI", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    mockList.mockResolvedValue([
      { id: "site_1", client_slug: "acme", status: "ready" },
      { id: "site_2", client_slug: "beta", status: "draft" },
    ]);
    const res = await listGET(jsonReq("http://t/api/sites", "GET", { auth: "Bearer t" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects).toHaveLength(2);
    expect(body.projects[0].id).toBe("site_1");
    expect(body.projects[1].id).toBe("site_2");
  });

  test("archived contract — route returns whatever listSiteProjects returns; lib filters status != archived in SQL", async () => {
    // Contract: `listSiteProjects` in `src/lib/sites.ts` filters
    // `WHERE status != 'archived'` at the SQL layer. The ROUTE must not
    // second-guess that filter — it just passes through. This test
    // verifies the route doesn't accidentally re-include archived rows
    // it was handed, and doesn't strip rows the lib returned.
    mockGetUser.mockReturnValue(SALES_USER);
    mockList.mockResolvedValue([
      { id: "site_active_1", status: "ready" },
      { id: "site_active_2", status: "draft" },
    ]);
    const res = await listGET(jsonReq("http://t/api/sites", "GET", { auth: "Bearer t" }));
    expect(res.status).toBe(200);
    const { projects } = await res.json();
    // All ids from the mock pass through untouched.
    expect(projects.map((p: { id: string }) => p.id)).toEqual([
      "site_active_1",
      "site_active_2",
    ]);
    // And nothing the lib didn't return shows up.
    expect(projects.find((p: { status: string }) => p.status === "archived")).toBeUndefined();
  });
});

/* ========================================================================== *
 * 2. CREATE flow — POST /api/sites
 * ========================================================================== */

describe("sites lifecycle — create flow (POST /api/sites)", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await listPOST(jsonReq("http://t/api/sites", "POST", { body: { brief: VALID_BRIEF } }));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("400 when body is missing entirely", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    const res = await listPOST(jsonReq("http://t/api/sites", "POST", { auth: "Bearer t", body: {} }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/brief required/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("400 when JSON body is unparseable", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    const req = new NextRequest("http://t/api/sites", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await listPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid JSON/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("422 on invalid slug (uppercase) surfaces BriefValidationError.errors array", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    mockCreate.mockRejectedValueOnce(
      new FakeBriefError(["client must be a lowercase slug (a-z, 0-9, -; 2-39 chars)"]),
    );
    const res = await listPOST(
      jsonReq("http://t/api/sites", "POST", {
        auth: "Bearer t",
        body: { brief: { ...VALID_BRIEF, client: "ABC" } },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/lowercase slug/)]));
  });

  test("422 on invalid slug (too short) surfaces BriefValidationError.errors array", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    mockCreate.mockRejectedValueOnce(
      new FakeBriefError(["client must be a lowercase slug (a-z, 0-9, -; 2-39 chars)"]),
    );
    const res = await listPOST(
      jsonReq("http://t/api/sites", "POST", {
        auth: "Bearer t",
        body: { brief: { ...VALID_BRIEF, client: "a" } },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors[0]).toMatch(/slug/);
  });

  test("422 when brief is missing product.name", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    mockCreate.mockRejectedValueOnce(new FakeBriefError(["product.name required"]));
    const res = await listPOST(
      jsonReq("http://t/api/sites", "POST", {
        auth: "Bearer t",
        body: { brief: { client: "acme", product: {}, pages: [{ route: "/", sections: [] }] } },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors).toContain("product.name required");
  });

  test("201 returns created project with draft status", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    const created = {
      id: "site_new",
      client_slug: "acme",
      display_name: "Acme Industries",
      status: "draft",
      brief: VALID_BRIEF,
    };
    mockCreate.mockResolvedValueOnce(created);
    const res = await listPOST(
      jsonReq("http://t/api/sites", "POST", { auth: "Bearer t", body: { brief: VALID_BRIEF } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.id).toBe("site_new");
    expect(body.project.status).toBe("draft");
    expect(mockCreate).toHaveBeenCalledWith(VALID_BRIEF, SALES_USER.id, SALES_USER.role);
  });

  test("500 on unexpected library error (not BriefValidationError)", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    mockCreate.mockRejectedValueOnce(new Error("db connection lost"));
    const res = await listPOST(
      jsonReq("http://t/api/sites", "POST", { auth: "Bearer t", body: { brief: VALID_BRIEF } }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Internal server error/);
  });
});

/* ========================================================================== *
 * 3. READ flow — GET /api/sites/[id]
 * ========================================================================== */

describe("sites lifecycle — read flow (GET /api/sites/[id])", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await detailGET(
      jsonReq("http://t/api/sites/site_abc", "GET"),
      { params: Promise.resolve({ id: "site_abc" }) },
    );
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("404 when project is missing", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    mockGet.mockResolvedValueOnce(null);
    const res = await detailGET(
      jsonReq("http://t/api/sites/site_missing", "GET", { auth: "Bearer t" }),
      { params: Promise.resolve({ id: "site_missing" }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/);
  });

  test("200 returns { project } with the expected shape", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    const project = {
      id: "site_abc",
      client_slug: "acme",
      display_name: "Acme Industries",
      status: "ready",
      brief: VALID_BRIEF,
    };
    mockGet.mockResolvedValueOnce(project);
    const res = await detailGET(
      jsonReq("http://t/api/sites/site_abc", "GET", { auth: "Bearer t" }),
      { params: Promise.resolve({ id: "site_abc" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe("site_abc");
    expect(body.project.status).toBe("ready");
    expect(body.project.brief.client).toBe("acme");
  });
});

/* ========================================================================== *
 * 4. ARCHIVE (soft-delete) — covered in sites-delete.test.ts. Do NOT duplicate.
 * ========================================================================== */

/* ========================================================================== *
 * 5. HARD-DELETE flow — DELETE /api/sites/[id]?hard=true
 * ========================================================================== */

describe("sites lifecycle — hard-delete flow (DELETE /api/sites/[id]?hard=true)", () => {
  function hardDeleteReq(id: string, role: string | null, auth = "Bearer t") {
    void role; // role is set on the mocked user; included for readability.
    return new NextRequest(`http://t/api/sites/${id}?hard=true`, {
      method: "DELETE",
      headers: { authorization: auth },
    });
  }

  test("401 without auth (even with ?hard=true)", async () => {
    mockGetUser.mockReturnValue(null);
    const req = new NextRequest("http://t/api/sites/site_abc?hard=true", { method: "DELETE" });
    const res = await detailDELETE(req, { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("403 when sales role attempts ?hard=true", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    const res = await detailDELETE(hardDeleteReq("site_abc", "sales"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("role_insufficient");
    expect(mockDelete).not.toHaveBeenCalled();
    // Must NOT audit a denied hard-delete — audit happens only on success.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test("403 when dev role attempts ?hard=true (hr threshold)", async () => {
    mockGetUser.mockReturnValue({ ...CTO_USER, id: "u_dev", role: "dev" as const });
    const res = await detailDELETE(hardDeleteReq("site_abc", "dev"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("role_insufficient");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("hr role succeeds — calls deleteSiteProject({hard:true}) + audits site.hard_deleted", async () => {
    mockGetUser.mockReturnValue(HR_USER);
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Acme Industries", client_slug: "acme", status: "archived" },
      cleanup: {
        githubRepo: { attempted: true, ok: true, alreadyGone: false },
        vercelProject: { attempted: true, ok: true, alreadyGone: false },
      },
    });
    const res = await detailDELETE(hardDeleteReq("site_abc", "hr"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cleanup.githubRepo.ok).toBe(true);
    expect(body.cleanup.vercelProject.ok).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith("site_abc", HR_USER.id, "hr", { hard: true });
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.hard_deleted");
    expect(auditCall.resourceType).toBe("site_project");
    expect(auditCall.resourceId).toBe("site_abc");
    expect(auditCall.afterState.hard).toBe(true);
    expect(auditCall.afterState.cleanup.githubRepo.ok).toBe(true);
  });

  test("cto role succeeds (ceo/cto also above hr threshold)", async () => {
    mockGetUser.mockReturnValue(CTO_USER);
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Acme", client_slug: "acme", status: "archived" },
      cleanup: {
        githubRepo: { attempted: true, ok: true, alreadyGone: false },
        vercelProject: { attempted: true, ok: true, alreadyGone: false },
      },
    });
    const res = await detailDELETE(hardDeleteReq("site_abc", "cto"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("site_abc", CTO_USER.id, "cto", { hard: true });
  });

  test("404 when project does not exist — no audit written", async () => {
    mockGetUser.mockReturnValue(HR_USER);
    mockDelete.mockResolvedValue({ project: null, cleanup: null });
    const res = await detailDELETE(hardDeleteReq("site_missing", "hr"), {
      params: Promise.resolve({ id: "site_missing" }),
    });
    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test("githubRepo cleanup failure is NON-FATAL — returns 200, audit captures failure", async () => {
    mockGetUser.mockReturnValue(HR_USER);
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Acme", client_slug: "acme", status: "archived" },
      cleanup: {
        githubRepo: { attempted: true, ok: false, error: "github 403: token lacks delete_repo" },
        vercelProject: { attempted: true, ok: true, alreadyGone: false },
      },
    });
    const res = await detailDELETE(hardDeleteReq("site_abc", "hr"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cleanup.githubRepo.ok).toBe(false);
    expect(body.cleanup.githubRepo.error).toMatch(/delete_repo/);
    // Audit still fires so the learning loop sees the partial-failure outcome.
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.hard_deleted");
    expect(auditCall.afterState.cleanup.githubRepo.ok).toBe(false);
    expect(auditCall.afterState.cleanup.githubRepo.error).toMatch(/delete_repo/);
  });

  test("vercel cleanup skipped (alreadyGone) — returns 200, audit reflects skipped state", async () => {
    mockGetUser.mockReturnValue(HR_USER);
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Acme", client_slug: "acme", status: "archived" },
      cleanup: {
        githubRepo: { attempted: true, ok: true, alreadyGone: false },
        vercelProject: { attempted: true, ok: true, alreadyGone: true },
      },
    });
    const res = await detailDELETE(hardDeleteReq("site_abc", "hr"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleanup.vercelProject.ok).toBe(true);
    expect(body.cleanup.vercelProject.alreadyGone).toBe(true);
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.afterState.cleanup.vercelProject.alreadyGone).toBe(true);
  });

  test("both cleanups failing still archives the row + audits the failure", async () => {
    mockGetUser.mockReturnValue(HR_USER);
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Acme", client_slug: "acme", status: "archived" },
      cleanup: {
        githubRepo: { attempted: true, ok: false, error: "github 500" },
        vercelProject: { attempted: true, ok: false, error: "vercel 500" },
      },
    });
    const res = await detailDELETE(hardDeleteReq("site_abc", "hr"), {
      params: Promise.resolve({ id: "site_abc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleanup.githubRepo.ok).toBe(false);
    expect(body.cleanup.vercelProject.ok).toBe(false);
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.hard_deleted");
    expect(auditCall.afterState.cleanup.githubRepo.error).toMatch(/github 500/);
    expect(auditCall.afterState.cleanup.vercelProject.error).toMatch(/vercel 500/);
  });

  test("?hard=false (explicit) falls back to soft-archive path", async () => {
    // Regression: ?hard=false must NOT trip the role gate — sales should
    // still be able to archive. The gate is `isHard === true` only.
    mockGetUser.mockReturnValue(SALES_USER);
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Acme", client_slug: "acme", status: "archived" },
      cleanup: null,
    });
    const req = new NextRequest("http://t/api/sites/site_abc?hard=false", {
      method: "DELETE",
      headers: { authorization: "Bearer t" },
    });
    const res = await detailDELETE(req, { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("site_abc", SALES_USER.id, "sales", { hard: false });
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.archived");
  });
});

/* ========================================================================== *
 * 6. STATE-TRANSITION flow — draft → deploying → archived is surfaced through
 * `status` on successive GETs. Route is a pass-through, so we verify the
 * shape carries the status field through untouched on every read.
 * ========================================================================== */

describe("sites lifecycle — status transitions surface through GET", () => {
  test("status=draft, deploying, ready, failed, archived all pass through unmodified", async () => {
    mockGetUser.mockReturnValue(SALES_USER);
    for (const status of ["draft", "provisioning", "deploying", "ready", "failed", "archived"] as const) {
      mockGet.mockResolvedValueOnce({ id: "site_abc", status, brief: VALID_BRIEF });
      const res = await detailGET(
        jsonReq("http://t/api/sites/site_abc", "GET", { auth: "Bearer t" }),
        { params: Promise.resolve({ id: "site_abc" }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project.status).toBe(status);
    }
  });
});
