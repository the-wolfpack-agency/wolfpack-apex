/**
 * audit-log-api.test.ts — admin endpoints (list / verify / export).
 *
 * Mocks audit-log + auth. Asserts:
 *   - auth required (401)
 *   - role gate (403 for non-admin)
 *   - filter params are forwarded
 *   - export returns NDJSON with correct content-type
 *   - verify emits tamper event on failure
 */

 

const mockQueryAuditLog = jest.fn();
const mockVerifyChain = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  queryAuditLog: (...args: unknown[]) => mockQueryAuditLog(...args),
  verifyChain: (...args: unknown[]) => mockVerifyChain(...args),
}));

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

// capability layer — returns empty caps; our endpoints fall back to role check
jest.mock("@/lib/auth/require-capability", () => ({
  effectiveCapabilitiesFor: jest.fn(async () => ({
    capabilities: new Set<string>(),
    overrides: {},
  })),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { GET as LIST } from "@/app/api/admin/audit-log/route";
import { POST as VERIFY } from "@/app/api/admin/audit-log/verify/route";
import { GET as EXPORT, exportAttempts } from "@/app/api/admin/audit-log/export/route";

function makeReq(path: string, opts: { method?: string; auth?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth) headers["authorization"] = opts.auth;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const ADMIN = { id: "u_admin", email: "cto@wp.dev", name: "Admin", role: "cto" as const, created_at: "" };
const NON_ADMIN = { id: "u_dev", email: "dev@wp.dev", name: "Dev", role: "dev" as const, created_at: "" };

beforeEach(() => {
  jest.clearAllMocks();
  exportAttempts.clear();
});

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------
describe("GET /api/admin/audit-log", () => {
  it("401 with no auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await LIST(makeReq("/api/admin/audit-log"));
    expect(res.status).toBe(401);
  });

  it("403 for non-admin", async () => {
    mockGetUser.mockReturnValueOnce(NON_ADMIN);
    const res = await LIST(makeReq("/api/admin/audit-log", { auth: "Bearer t" }));
    expect(res.status).toBe(403);
  });

  it("200 for admin with filters forwarded", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockQueryAuditLog.mockResolvedValueOnce({ entries: [{ id: "a", seq: 1 }], nextCursor: "c2" });
    const res = await LIST(
      makeReq(
        "/api/admin/audit-log?actor_user_id=u1&resource_type=employee&limit=10&since=2026-04-10T00:00:00.000Z",
        { auth: "Bearer t" },
      ),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(1);
    expect(data.nextCursor).toBe("c2");
    const arg = mockQueryAuditLog.mock.calls[0][0];
    expect(arg.actorUserId).toBe("u1");
    expect(arg.resourceType).toBe("employee");
    expect(arg.limit).toBe(10);
    expect(arg.since instanceof Date).toBe(true);
  });

  it("emits system.audit_log_viewed", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockQueryAuditLog.mockResolvedValueOnce({ entries: [], nextCursor: undefined });
    await LIST(makeReq("/api/admin/audit-log", { auth: "Bearer t" }));
    expect(mockTrack).toHaveBeenCalledWith(
      "system.audit_log_viewed",
      ADMIN.id,
      ADMIN.role,
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// VERIFY
// ---------------------------------------------------------------------------
describe("POST /api/admin/audit-log/verify", () => {
  it("401 no auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await VERIFY(makeReq("/api/admin/audit-log/verify", { method: "POST", body: {} }));
    expect(res.status).toBe(401);
  });

  it("200 valid chain, no tamper event emitted", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockVerifyChain.mockResolvedValueOnce({ valid: true, checkedCount: 5 });
    const res = await VERIFY(
      makeReq("/api/admin/audit-log/verify", { method: "POST", auth: "Bearer t", body: {} }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(true);
    const tamperEmitted = mockTrack.mock.calls.some((c) => c[0] === "system.audit_log_tamper_suspected");
    expect(tamperEmitted).toBe(false);
  });

  it("emits system.audit_log_tamper_suspected when chain broken", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockVerifyChain.mockResolvedValueOnce({ valid: false, brokenAt: 7, checkedCount: 6, reason: "entry_hash_mismatch" });
    const res = await VERIFY(
      makeReq("/api/admin/audit-log/verify", { method: "POST", auth: "Bearer t", body: {} }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.brokenAt).toBe(7);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.audit_log_tamper_suspected",
      ADMIN.id,
      ADMIN.role,
      expect.objectContaining({ broken_at: 7 }),
    );
  });
});

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------
describe("GET /api/admin/audit-log/export", () => {
  it("401 no auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await EXPORT(makeReq("/api/admin/audit-log/export"));
    expect(res.status).toBe(401);
  });

  it("returns NDJSON with correct content-type and one JSON object per line", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockQueryAuditLog.mockResolvedValueOnce({
      entries: [
        { id: "a", seq: 2, action: "x" },
        { id: "b", seq: 1, action: "y" },
      ],
      nextCursor: undefined,
    });
    const res = await EXPORT(makeReq("/api/admin/audit-log/export", { auth: "Bearer t" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe("a");
    expect(JSON.parse(lines[1]).id).toBe("b");
  });

  it("emits system.audit_log_export", async () => {
    mockGetUser.mockReturnValueOnce(ADMIN);
    mockQueryAuditLog.mockResolvedValueOnce({ entries: [], nextCursor: undefined });
    await EXPORT(makeReq("/api/admin/audit-log/export", { auth: "Bearer t" }));
    expect(mockTrack).toHaveBeenCalledWith(
      "system.audit_log_export",
      ADMIN.id,
      ADMIN.role,
      expect.any(Object),
    );
  });

  it("rate-limits after configured threshold", async () => {
    // Exhaust allowance
    for (let i = 0; i < 3; i++) {
      mockGetUser.mockReturnValueOnce(ADMIN);
      mockQueryAuditLog.mockResolvedValueOnce({ entries: [], nextCursor: undefined });
      const ok = await EXPORT(makeReq("/api/admin/audit-log/export", { auth: "Bearer t" }));
      expect(ok.status).toBe(200);
    }
    mockGetUser.mockReturnValueOnce(ADMIN);
    const over = await EXPORT(makeReq("/api/admin/audit-log/export", { auth: "Bearer t" }));
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBeTruthy();
  });
});
