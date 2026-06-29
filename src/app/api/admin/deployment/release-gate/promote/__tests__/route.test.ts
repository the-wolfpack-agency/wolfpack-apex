/**
 * Contract for POST /api/admin/deployment/release-gate/promote.
 *
 * Proves: capability gate (deploy.promote) -> 401/403; ready PR -> 200 +
 * mergedSha + recordAudit("deploy.production_promoted") + analytics; NOT-ready
 * PR -> 400 with the reason AND no audit (nothing changed in prod); bad body ->
 * 400. promoteChange is mocked so this is a pure route contract - the lib's own
 * fail-closed logic is proven in release-gate.test.ts.
 */
const mockPromote = jest.fn();
const mockTrack = jest.fn();
const mockRecordAudit = jest.fn().mockResolvedValue(undefined);
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/deploy/release-gate", () => ({
  promoteChange: (...a: unknown[]) => mockPromote(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/deployment/release-gate/promote/route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/deployment/release-gate/promote", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "cto", workspaceId: "ws-1" } });
});

describe("POST /api/admin/deployment/release-gate/promote", () => {
  it("ready PR -> 200 + mergedSha, calls promoteChange, audits, tracks", async () => {
    mockPromote.mockResolvedValue({ ok: true, mergedSha: "deadbeef" });
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mergedSha: "deadbeef" });
    expect(mockPromote).toHaveBeenCalledWith(42);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "deploy.production_promoted",
        resourceType: "deployment",
        resourceId: "42",
        afterState: { prNumber: 42, mergedSha: "deadbeef" },
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "deploy.release_gate_viewed",
      "admin-1",
      "cto",
      expect.objectContaining({ promoted_pr: 42, merged_sha: "deadbeef" }),
    );
  });

  it("NOT-ready PR -> 400 with reason and NO audit (nothing changed in prod)", async () => {
    mockPromote.mockResolvedValue({ ok: false, reason: "Not ready to promote: Tests are failing - fix needed." });
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "Not ready to promote: Tests are failing - fix needed.",
    });
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("accepts a numeric-string prNumber", async () => {
    mockPromote.mockResolvedValue({ ok: true, mergedSha: "sha" });
    const res = await post({ prNumber: "42" });
    expect(res.status).toBe(200);
    expect(mockPromote).toHaveBeenCalledWith(42);
  });

  it("400s on a missing / invalid prNumber and never calls promoteChange", async () => {
    const res = await post({ prNumber: "not-a-number" });
    expect(res.status).toBe(400);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/admin/deployment/release-gate/promote", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("403s when the deploy.promote capability is denied (no promote)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(403);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(401);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});
