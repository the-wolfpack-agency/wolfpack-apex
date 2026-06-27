/**
 * Contract for POST /api/admin/platform-scans/findings/bulk (bulk triage).
 * Gated on settings.manage_team; body status must be acknowledged|resolved.
 * The store + audit are mocked so the route's auth + validation + filter wiring +
 * audit call are exercised without a DB.
 */
const mockBulk = jest.fn();
const mockRecordAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => mockAuth(),
}));
jest.mock("@/lib/platform-scan/store", () => ({
  bulkTriageFindings: (...a: unknown[]) => mockBulk(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/findings/bulk/route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/findings/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockBulk.mockResolvedValue(7);
  mockRecordAudit.mockResolvedValue(undefined);
});

it("bulk-triages the active severity + platform filter, returns the count (200), and audits", async () => {
  const res = await post({ status: "acknowledged", severity: "critical,high", platform: "acme-crm" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, count: 7 });
  expect(mockBulk).toHaveBeenCalledWith(
    "ws-1",
    { status: "acknowledged", severities: ["critical", "high"], platform: "acme-crm" },
    "admin-1",
    "admin",
  );
  // Hash-chain audited.
  expect(mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "platform.findings_bulk_triaged",
      resourceType: "platform_scan_finding",
      afterState: expect.objectContaining({ status: "acknowledged", count: 7 }),
    }),
  );
});

it("accepts a severity string[] as well as a csv", async () => {
  await post({ status: "resolved", severity: ["critical"] });
  expect(mockBulk).toHaveBeenCalledWith(
    "ws-1",
    { status: "resolved", severities: ["critical"], platform: undefined },
    "admin-1",
    "admin",
  );
});

it("with no severity/platform passes undefined (all open findings)", async () => {
  await post({ status: "resolved" });
  expect(mockBulk).toHaveBeenCalledWith(
    "ws-1",
    { status: "resolved", severities: undefined, platform: undefined },
    "admin-1",
    "admin",
  );
});

it("400s an invalid status with no store call", async () => {
  const res = await post({ status: "nuke" });
  expect(res.status).toBe(400);
  expect(mockBulk).not.toHaveBeenCalled();
});

it("400s a non-JSON body", async () => {
  const res = await POST(
    new NextRequest("http://localhost/api/admin/platform-scans/findings/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );
  expect(res.status).toBe(400);
  expect(mockBulk).not.toHaveBeenCalled();
});

it("403s when the capability gate fails (no bulk triage)", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await post({ status: "acknowledged" });
  expect(res.status).toBe(403);
  expect(mockBulk).not.toHaveBeenCalled();
});
