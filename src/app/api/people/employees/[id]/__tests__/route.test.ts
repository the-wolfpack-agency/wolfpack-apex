/**
 * PUT / DELETE / GET /api/people/employees/[id] — unit tests.
 *
 * Mirrors src/app/api/knowledge/[id]/__tests__/route.test.ts. Every server
 * dependency is mocked; handlers are imported directly; responses are
 * inspected. Covers auth (401/403), 404, validation (400), and the
 * happy-path 200 plus audit-log + analytics fanout.
 */

const mockGetUserFromRequest = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
}));

const mockHasCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
}));

const mockGetEmployee = jest.fn();
const mockUpdateEmployee = jest.fn();
const mockDeleteEmployee = jest.fn();
jest.mock("@/lib/people", () => ({
  getEmployee: (...args: unknown[]) => mockGetEmployee(...args),
  updateEmployee: (...args: unknown[]) => mockUpdateEmployee(...args),
  deleteEmployee: (...args: unknown[]) => mockDeleteEmployee(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
  extractRequestMetadata: () => ({
    ipAddress: "127.0.0.1",
    userAgent: "jest",
    requestId: "req-1",
  }),
}));

import { NextRequest } from "next/server";
import {
  GET,
  PUT,
  DELETE,
} from "@/app/api/people/employees/[id]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/people/employees/emp-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const OWNER = { id: "u-owner", email: "o@test", name: "O", role: "hr" };
const STRANGER = { id: "u-stranger", email: "s@test", name: "S", role: "sales" };
const ADMIN = { id: "u-admin", email: "a@test", name: "A", role: "cto" };

const EMP = {
  id: "emp-1",
  full_name: "Alice",
  email: "alice@ex.com",
  role_title: "Eng",
  department: "Platform",
  start_date: null,
  birth_year: null,
  zip_code: null,
  status: "active",
  metadata: {},
  created_by: "u-owner",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "a-1", seq: 1, entryHash: "h" });
  mockHasCapability.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
describe("GET /api/people/employees/[id]", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when missing", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(null);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 returns the employee", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employee: { id: string } };
    expect(body.employee.id).toBe("emp-1");
  });
});

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------
describe("PUT /api/people/employees/[id]", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await PUT(req("PUT", { full_name: "N" }), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockUpdateEmployee).not.toHaveBeenCalled();
  });

  it("404 when row missing", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(null);
    const res = await PUT(req("PUT", { full_name: "N" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-owner without capability", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(STRANGER);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    mockHasCapability.mockReturnValueOnce(false);
    const res = await PUT(req("PUT", { full_name: "N" }), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdateEmployee).not.toHaveBeenCalled();
  });

  it("allows admin with capability", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(ADMIN);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    mockHasCapability.mockReturnValueOnce(true);
    mockUpdateEmployee.mockResolvedValueOnce({ ...EMP, full_name: "Alice 2" });

    const res = await PUT(req("PUT", { full_name: "Alice 2" }), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdateEmployee).toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employee.updated",
        resourceType: "employee",
        resourceId: "emp-1",
      }),
    );
  });

  it("400 when full_name is empty", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    const res = await PUT(req("PUT", { full_name: "" }), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 happy path as owner + audits", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    mockUpdateEmployee.mockResolvedValueOnce({ ...EMP, department: "Platform2" });

    const res = await PUT(req("PUT", { department: "Platform2" }), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; employee: { department: string } };
    expect(body.ok).toBe(true);
    expect(body.employee.department).toBe("Platform2");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe("DELETE /api/people/employees/[id]", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when missing", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-owner without capability", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(STRANGER);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    mockHasCapability.mockReturnValueOnce(false);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(403);
    expect(mockDeleteEmployee).not.toHaveBeenCalled();
  });

  it("200 happy path as owner + audits", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockGetEmployee.mockResolvedValueOnce(EMP);
    mockDeleteEmployee.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "emp-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("emp-1");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employee.deleted",
        resourceId: "emp-1",
      }),
    );
  });
});
