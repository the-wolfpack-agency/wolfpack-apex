/**
 * DELETE /api/sites/[id] — soft-delete (archive) a site project.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
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
    mockDelete.mockResolvedValue(null);
    const res = await DELETE(makeReq("Bearer t"), { params: Promise.resolve({ id: "site_nope" }) });
    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test("200 + soft-deletes + writes audit on happy path", async () => {
    mockGetUser.mockReturnValue(USER);
    mockDelete.mockResolvedValue({
      id: "site_abc",
      display_name: "Avis",
      client_slug: "avis",
      status: "archived",
    });
    const res = await DELETE(makeReq("Bearer t"), { params: Promise.resolve({ id: "site_abc" }) });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("site_abc", "u_1", "cto");
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const auditCall = mockAudit.mock.calls[0][0];
    expect(auditCall.action).toBe("site.archived");
    expect(auditCall.resourceType).toBe("site_project");
    expect(auditCall.resourceId).toBe("site_abc");
  });
});
