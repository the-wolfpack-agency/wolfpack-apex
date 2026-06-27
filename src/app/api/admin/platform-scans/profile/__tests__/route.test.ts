/**
 * Contract for the system-profiler route. Auth (settings.manage_team), manifest
 * resolution, and the build -> save -> Brain ingest -> analytics -> audit handoff,
 * with all I/O mocked so no network/DB is touched.
 */
const mockBuild = jest.fn();
const mockSave = jest.fn();
const mockIngest = jest.fn();
const mockGet = jest.fn();
const mockList = jest.fn();
const mockResolve = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/manifests", () => ({ resolveScanTarget: (...a: unknown[]) => mockResolve(...a) }));
jest.mock("@/lib/platform-scan/static/discover-files", () => ({ discoverRepoFiles: async () => [] }));
jest.mock("@/lib/platform-scan/static/scan", () => ({ defaultReadFile: () => async () => null }));
jest.mock("@/lib/platform-scan/store", () => ({ summarizeFindings: async () => ({ bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, total: 0 }) }));
jest.mock("@/lib/platform-scan/profile/build", () => ({ buildSystemProfile: (...a: unknown[]) => mockBuild(...a) }));
jest.mock("@/lib/platform-scan/profile/store", () => ({
  saveSystemProfile: (...a: unknown[]) => mockSave(...a),
  getSystemProfile: (...a: unknown[]) => mockGet(...a),
  listSystemProfiles: (...a: unknown[]) => mockList(...a),
}));
jest.mock("@/lib/platform-scan/profile/brain-ingest", () => ({ ingestSystemProfile: (...a: unknown[]) => mockIngest(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => { mockAudit(...a); return Promise.resolve(); },
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/admin/platform-scans/profile/route";

const PROFILE = {
  platform: "wolfpack-auto",
  surface: { pages: 5, apiRoutes: 10, components: 3, libModules: 8, migrations: 12, tests: 20, totalFiles: 100 },
  entities: ["leads", "deals"],
  integrations: [{ name: "Stripe", package: "stripe", category: "Payments" }],
  authModel: { publicRoutes: 4, protectedRoutes: 9 },
  riskSummary: { critical: 1, high: 2, medium: 0, low: 0, total: 3 },
  generatedAt: "2026-06-27T08:00:00.000Z",
};

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/admin/platform-scans/profile", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockBuild.mockResolvedValue(PROFILE);
  mockResolve.mockResolvedValue({ static: { owner: "o", repo: "r", ref: "main" }, routes: [{ auth: "required" }] });
});

it("builds, saves, Brain-ingests, tracks, audits, and returns the profile", async () => {
  const res = await post({ platform: "wolfpack-auto" });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toMatchObject({ ok: true, platform: "wolfpack-auto" });
  expect(json.profile.entities).toEqual(["leads", "deals"]);
  expect(mockSave).toHaveBeenCalledWith("ws-1", PROFILE);
  expect(mockIngest).toHaveBeenCalledWith(PROFILE);
  expect(mockTrack).toHaveBeenCalledWith("platform.system_profiled", "admin-1", "admin", expect.objectContaining({ platform: "wolfpack-auto", entities: 2, integrations: 1 }));
  expect(mockAudit).toHaveBeenCalled();
});

it("400 when platform missing", async () => {
  const res = await post({});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("platform_required");
  expect(mockBuild).not.toHaveBeenCalled();
});

it("404 on unknown platform", async () => {
  mockResolve.mockResolvedValue(null);
  const res = await post({ platform: "nope" });
  expect(res.status).toBe(404);
});

it("400 when the target has no static (repo) target to introspect", async () => {
  mockResolve.mockResolvedValue({ routes: [], baseUrl: "https://x" });
  const res = await post({ platform: "http-only" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("no_static_target");
});

it("refuses an unauthorized caller and never builds", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await post({ platform: "wolfpack-auto" });
  expect(res.status).toBe(403);
  expect(mockBuild).not.toHaveBeenCalled();
});

it("GET returns the saved profile", async () => {
  mockGet.mockResolvedValue({ profile: PROFILE, generatedAt: PROFILE.generatedAt });
  const res = await GET(new NextRequest("http://localhost/api/admin/platform-scans/profile?platform=wolfpack-auto"));
  expect(res.status).toBe(200);
  expect((await res.json()).profile.platform).toBe("wolfpack-auto");
});
