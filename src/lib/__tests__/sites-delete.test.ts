/**
 * DELETE /api/sites/[id] — soft-delete (archive) a site project.
 */

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
  hasRole: (role: string, required: string) => {
    const levels: Record<string, number> = { ceo: 5, cto: 5, hr: 4, dev: 3, ops: 2, sales: 1 };
    return (levels[role] ?? 0) >= (levels[required] ?? 0);
  },
}));

const mockDelete = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...a: unknown[]) => mockGet(...a),
  updateBrief: jest.fn(),
  triggerDeploy: jest.fn(),
  deleteSiteProject: (...a: unknown[]) => mockDelete(...a),
  BriefValidationError: class extends Error {
    errors: unknown;
    constructor(m: string, errors: unknown) { super(m); this.errors = errors; }
  },
}));

const mockAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "127.0.0.1", userAgent: "jest", requestId: "req-1" }),
}));

import { getUserFromRequest } from "@/lib/auth";
import { NextRequest } from "next/server";
import { DELETE } from "@/app/api/sites/[id]/route";

const mockGetUser = getUserFromRequest as jest.MockedFunction<typeof getUserFromRequest>;

function makeReq(auth?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  return new NextRequest("http://localhost/api/sites/site_abc", { method: "DELETE", headers });
}

const USER = { id: "u_1", email: "a@b", name: "A", role: "cto" as const, created_at: "" };

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

describe("DELETE /api/sites/[id]", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await DELETE(makeReq(), { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("404 when site doesn't exist", async () => {
    mockGetUser.mockReturnValue(USER);
    mockDelete.mockResolvedValue({ project: null, cleanup: null });
    const res = await DELETE(makeReq("Bearer t"), { params: Promise.resolve({ id: "site_nope" }) });
    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test("200 + soft-deletes + writes audit on happy path", async () => {
    mockGetUser.mockReturnValue(USER);
    mockDelete.mockResolvedValue({
      project: {
        id: "site_abc",
        display_name: "Avis",
        client_slug: "avis",
        status: "archived",
      },
      cleanup: null,
    });
    const res = await DELETE(makeReq("Bearer t"), { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("site_abc", "u_1", "cto", { hard: false });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.archived");
    expect(auditCall.resourceType).toBe("site_project");
    expect(auditCall.resourceId).toBe("site_abc");
  });

  // Hard-delete regression — 2026-04-18.
  test("?hard=true requires hr+ role (sales gets 403)", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "sales" as const });
    const req = new NextRequest("http://localhost/api/sites/site_abc?hard=true", {
      method: "DELETE",
      headers: { authorization: "Bearer t" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("role_insufficient");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("?hard=true with hr role calls deleteSiteProject({hard:true}) + audits site.hard_deleted with cleanup", async () => {
    mockGetUser.mockReturnValue({ ...USER, role: "hr" as const });
    mockDelete.mockResolvedValue({
      project: { id: "site_abc", display_name: "Avis", client_slug: "avis", status: "archived" },
      cleanup: {
        githubRepo: { attempted: true, ok: true, alreadyGone: false },
        vercelProject: { attempted: true, ok: true, alreadyGone: true },
      },
    });
    const req = new NextRequest("http://localhost/api/sites/site_abc?hard=true", {
      method: "DELETE",
      headers: { authorization: "Bearer t" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleanup.githubRepo.ok).toBe(true);
    expect(body.cleanup.vercelProject.alreadyGone).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith("site_abc", "u_1", "hr", { hard: true });
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.hard_deleted");
    expect(auditCall.afterState.hard).toBe(true);
    expect(auditCall.afterState.cleanup.githubRepo.ok).toBe(true);
  });
});
