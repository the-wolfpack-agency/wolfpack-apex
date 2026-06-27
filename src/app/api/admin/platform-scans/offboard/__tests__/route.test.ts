/**
 * Contract tests for POST /api/admin/platform-scans/offboard.
 *
 * The destructive purge is double-guarded: a high capability AND an explicit
 * typed confirmation (confirm === workspaceId). These tests assert:
 *   - 200 with a matching confirm runs the purge + returns counts/residue;
 *   - 400 with a missing workspaceId, with NO confirm, and with the WRONG
 *     confirm - and in every refusal case the purge is NOT invoked;
 *   - 401 when unauthenticated, 403 when the capability is denied.
 *
 * The capability gate, the offboarding lib, and the audit log are mocked so the
 * route's branching is asserted in isolation - no real infra touched.
 */

let mockAuth: () => Promise<unknown>;
const mockOffboard = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/offboarding", () => ({
  offboardWorkspace: (...a: unknown[]) => mockOffboard(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue(undefined),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/offboard/route";

function post(body?: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/offboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

const PURGE_RESULT = {
  workspaceId: "acme-crm",
  counts: {
    instinct_platform_scan_findings: 12,
    instinct_platform_scans: 3,
    instinct_scan_targets: 1,
    instinct_target_verifications: 1,
    instinct_system_profiles: 1,
    instinct_automation_recommendations: 2,
    instinct_pentest_authorizations: 0,
    instinct_connector_credentials: 2,
  },
  residue: {},
  totalDeleted: 22,
  secondaryStoresClean: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "cto-1", role: "cto", workspaceId: "ws-1" } });
  mockOffboard.mockResolvedValue(PURGE_RESULT);
});

describe("POST /api/admin/platform-scans/offboard", () => {
  it("200 + purges when confirm matches the workspaceId", async () => {
    const res = await post({ workspaceId: "acme-crm", confirm: "acme-crm" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      workspaceId: "acme-crm",
      totalDeleted: 22,
      secondaryStoresClean: true,
    });
    expect(body.counts.instinct_platform_scan_findings).toBe(12);
    expect(mockOffboard).toHaveBeenCalledWith("acme-crm", { user_id: "cto-1", role: "cto" });
  });

  it("400 + NO purge when confirm is missing", async () => {
    const res = await post({ workspaceId: "acme-crm" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation_required");
    expect(mockOffboard).not.toHaveBeenCalled();
  });

  it("400 + NO purge when confirm does not match the workspaceId", async () => {
    const res = await post({ workspaceId: "acme-crm", confirm: "wrong-id" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation_required");
    expect(mockOffboard).not.toHaveBeenCalled();
  });

  it("400 + NO purge when workspaceId is missing", async () => {
    const res = await post({ confirm: "anything" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("workspace_id_required");
    expect(mockOffboard).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
    const res = await post({ workspaceId: "acme-crm", confirm: "acme-crm" });
    expect(res.status).toBe(401);
    expect(mockOffboard).not.toHaveBeenCalled();
  });

  it("403 when the capability is denied", async () => {
    mockAuth = async () => ({ ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    const res = await post({ workspaceId: "acme-crm", confirm: "acme-crm" });
    expect(res.status).toBe(403);
    expect(mockOffboard).not.toHaveBeenCalled();
  });

  it("returns residue when a secondary store was down", async () => {
    mockOffboard.mockResolvedValue({
      ...PURGE_RESULT,
      residue: { qdrant: "unreachable" },
      secondaryStoresClean: false,
    });
    const res = await post({ workspaceId: "acme-crm", confirm: "acme-crm" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secondaryStoresClean).toBe(false);
    expect(body.residue).toEqual({ qdrant: "unreachable" });
  });
});
