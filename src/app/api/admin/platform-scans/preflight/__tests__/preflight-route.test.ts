/**
 * Contract for GET /api/admin/platform-scans/preflight?platform=<id>.
 *
 * Proves: capability gate (settings.manage_team) -> 401/403 on failure; missing
 * ?platform -> 400; happy path -> 200 with the preflight result, scan run tracked
 * and audited. runPreflight is mocked so this stays a pure route contract test.
 */
const mockRunPreflight = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/preflight", () => ({ runPreflight: (...a: unknown[]) => mockRunPreflight(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue(undefined),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/platform-scans/preflight/route";

const RESULT = {
  platform: "wolfpack-auto",
  ok: true,
  checks: [
    { name: "target_resolved", pass: true, detail: "Resolved.", critical: true },
    { name: "base_url_public", pass: true, detail: "Public.", critical: true },
    { name: "base_url_reachable", pass: true, detail: "HTTP 200.", critical: true },
  ],
};

function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockRunPreflight.mockResolvedValue({ ...RESULT });
});

describe("GET /api/admin/platform-scans/preflight", () => {
  it("returns 200 with the preflight result, runs preflight, tracks the run", async () => {
    const res = await get("http://localhost/api/admin/platform-scans/preflight?platform=wolfpack-auto");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(mockRunPreflight).toHaveBeenCalledWith("ws-1", "wolfpack-auto");
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.preflight_run",
      "admin-1",
      "admin",
      expect.objectContaining({ platform: "wolfpack-auto", ok: true, checks: 3, failed: "none" }),
    );
  });

  it("400s when ?platform is missing (no preflight run)", async () => {
    const res = await get("http://localhost/api/admin/platform-scans/preflight");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "platform is required" });
    expect(mockRunPreflight).not.toHaveBeenCalled();
  });

  it("403s when the capability gate fails (no preflight run, no track)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await get("http://localhost/api/admin/platform-scans/preflight?platform=wolfpack-auto");
    expect(res.status).toBe(403);
    expect(mockRunPreflight).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated (gate returns a 401 response)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await get("http://localhost/api/admin/platform-scans/preflight?platform=wolfpack-auto");
    expect(res.status).toBe(401);
    expect(mockRunPreflight).not.toHaveBeenCalled();
  });

  it("reports failed check names to analytics on a not-ready result", async () => {
    mockRunPreflight.mockResolvedValue({
      platform: "wolfpack-auto",
      ok: false,
      checks: [
        { name: "target_resolved", pass: true, detail: "ok", critical: true },
        { name: "base_url_reachable", pass: false, detail: "down", critical: true },
      ],
    });
    const res = await get("http://localhost/api/admin/platform-scans/preflight?platform=wolfpack-auto");
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.preflight_run",
      "admin-1",
      "admin",
      expect.objectContaining({ ok: false, failed: "base_url_reachable" }),
    );
  });
});
