/**
 * Contract for GET /api/admin/deployment-readiness.
 *
 * Proves: capability gate (settings.manage_team) -> 401/403 on failure; happy
 * path -> 200 with the readiness result; the check is tracked
 * (platform.deployment_readiness_checked) and audited with the failed-check
 * names. runDeploymentReadiness is mocked so this stays a pure route contract.
 */
const mockRunReadiness = jest.fn();
const mockDefaultDeps = jest.fn(() => ({ wired: true }));
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/deploy/deployment-readiness", () => ({
  runDeploymentReadiness: (...a: unknown[]) => mockRunReadiness(...a),
  defaultReadinessDeps: () => mockDefaultDeps(),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue(undefined),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/deployment-readiness/route";

const RESULT = {
  ok: true,
  checks: [
    { name: "env:DATABASE_URL", pass: true, detail: "set", critical: true },
    { name: "connect:postgres", pass: true, detail: "ok", critical: true },
    { name: "connect:qdrant", pass: true, detail: "ok", critical: false },
  ],
};

function get() {
  return GET(new NextRequest("http://localhost/api/admin/deployment-readiness"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockRunReadiness.mockResolvedValue({ ...RESULT });
});

describe("GET /api/admin/deployment-readiness", () => {
  it("returns 200 with the readiness result, runs the check with the default deps, tracks it", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(mockRunReadiness).toHaveBeenCalledWith({ wired: true });
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.deployment_readiness_checked",
      "admin-1",
      "admin",
      expect.objectContaining({ ok: true, checks: 3, failed: "none" }),
    );
  });

  it("403s when the capability gate fails (no readiness run, no track)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await get();
    expect(res.status).toBe(403);
    expect(mockRunReadiness).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated (gate returns a 401 response)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await get();
    expect(res.status).toBe(401);
    expect(mockRunReadiness).not.toHaveBeenCalled();
  });

  it("reports failed check names to analytics on a not-ready result", async () => {
    mockRunReadiness.mockResolvedValue({
      ok: false,
      checks: [
        { name: "env:DATABASE_URL", pass: true, detail: "set", critical: true },
        { name: "connect:postgres", pass: false, detail: "down", critical: true },
        { name: "connect:qdrant", pass: false, detail: "down", critical: false },
      ],
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.deployment_readiness_checked",
      "admin-1",
      "admin",
      expect.objectContaining({ ok: false, failed: "connect:postgres,connect:qdrant" }),
    );
  });
});
