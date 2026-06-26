/**
 * Contract + e2e for /api/admin/platform-scans (POST run-scan, GET findings).
 *
 * Proves the run-scan pipeline end to end with the engine/store/manifest mocked:
 *   POST -> manifest resolved -> scan_started tracked -> scanPlatform run with the
 *     manifest's baseUrl + routes -> findings persisted via recordScan -> 200 with
 *     scanId + findings.
 *   POST unknown platform -> 404, the engine never runs.
 *   gate failure -> 403, nothing runs.
 *   GET -> findings from listFindings, with ?status / ?platform passed through.
 */
const mockGetManifest = jest.fn();
const mockScan = jest.fn();
const mockRecord = jest.fn();
const mockList = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => mockAuth(),
}));
jest.mock("@/lib/platform-scan/engine", () => ({
  scanPlatform: (...a: unknown[]) => mockScan(...a),
}));
jest.mock("@/lib/platform-scan/manifests", () => ({
  getScanManifest: (...a: unknown[]) => mockGetManifest(...a),
}));
jest.mock("@/lib/platform-scan/store", () => ({
  recordScan: (...a: unknown[]) => mockRecord(...a),
  listFindings: (...a: unknown[]) => mockList(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/admin/platform-scans/route";

const MANIFEST = {
  baseUrl: "https://target.example",
  routes: [
    { path: "/", journey: "home", auth: "public" as const },
    { path: "/admin", journey: "admin", auth: "required" as const },
  ],
};
const RESULT = {
  platform: "wolfpack-auto",
  baseUrl: "https://target.example",
  routeCount: 2,
  okCount: 1,
  findings: [
    {
      route: "/admin",
      severity: "critical" as const,
      category: "security" as const,
      title: "Admin served unauthenticated",
      detail: "200 with no auth",
      evidence: { status: 200 },
    },
  ],
};

function post(body?: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}
function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({
    ok: true,
    user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
  });
  mockGetManifest.mockReturnValue({ ...MANIFEST });
  mockScan.mockResolvedValue({ ...RESULT });
  mockRecord.mockResolvedValue({
    scanId: "scan-1",
    findingCount: 1,
    criticalCount: 1,
  });
  mockList.mockResolvedValue([{ id: "f-1", status: "open" }]);
});

describe("POST /api/admin/platform-scans", () => {
  it("runs the scan and persists findings (200 with scanId + findings)", async () => {
    const res = await post({ platform: "wolfpack-auto" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      scanId: "scan-1",
      findingCount: 1,
      criticalCount: 1,
      findings: RESULT.findings,
    });

    expect(mockGetManifest).toHaveBeenCalledWith("wolfpack-auto");
    // the engine ran against the manifest's target + the manifest's routes.
    expect(mockScan).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      platform: "wolfpack-auto",
      baseUrl: MANIFEST.baseUrl,
      routes: MANIFEST.routes,
    });
    // the scan result was persisted, attributed to the actor.
    expect(mockRecord).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "admin-1",
      actorRole: "admin",
      result: RESULT,
    });
    // the start event was emitted with the route count.
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.scan_started",
      "admin-1",
      "admin",
      { platform: "wolfpack-auto", route_count: 2 },
    );
  });

  it("defaults to the wolfpack-auto platform when body has none", async () => {
    await post({});
    expect(mockGetManifest).toHaveBeenCalledWith("wolfpack-auto");
  });

  it("404s an unknown platform and NEVER runs the engine", async () => {
    mockGetManifest.mockReturnValue(null);
    const res = await post({ platform: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_platform" });
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("403s when the capability gate fails (no scan)", async () => {
    mockAuth = async () => ({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await post({ platform: "wolfpack-auto" });
    expect(res.status).toBe(403);
    expect(mockGetManifest).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/platform-scans", () => {
  it("returns the workspace findings from listFindings", async () => {
    const res = await get("http://localhost/api/admin/platform-scans");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      findings: [{ id: "f-1", status: "open" }],
    });
    expect(mockList).toHaveBeenCalledWith("ws-1", {
      status: undefined,
      platform: undefined,
    });
  });

  it("passes ?status and ?platform through to listFindings", async () => {
    await get(
      "http://localhost/api/admin/platform-scans?status=open&platform=wolfpack-auto",
    );
    expect(mockList).toHaveBeenCalledWith("ws-1", {
      status: "open",
      platform: "wolfpack-auto",
    });
  });

  it("403s when the capability gate fails (no list call)", async () => {
    mockAuth = async () => ({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await get("http://localhost/api/admin/platform-scans");
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});
