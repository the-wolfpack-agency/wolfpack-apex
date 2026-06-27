/**
 * Contract + e2e for /api/admin/platform-scans (POST run-scan, GET findings).
 *
 * Proves the run-scan pipeline with engine/store/manifest/discover/static mocked:
 *   POST (http) -> manifest resolved -> sitemap routes discovered + merged with
 *     the seed -> scan_started tracked -> scanPlatform run with the MERGED routes
 *     -> findings persisted -> 200 with platform + scanId + findings.
 *   POST (static) -> scanSource run over the repo target -> persisted.
 *   POST unknown platform -> 404; static mode w/o a static target -> 400.
 *   gate failure -> 403. GET -> findings, ?status/?platform passed through.
 */
const mockResolveTarget = jest.fn();
const mockScan = jest.fn();
const mockScanSource = jest.fn();
const mockReadFile = jest.fn();
const mockDiscover = jest.fn();
const mockMerge = jest.fn();
const mockRecord = jest.fn();
const mockList = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/engine", () => ({ scanPlatform: (...a: unknown[]) => mockScan(...a) }));
jest.mock("@/lib/platform-scan/static/scan", () => ({
  scanSource: (...a: unknown[]) => mockScanSource(...a),
  defaultReadFile: (...a: unknown[]) => mockReadFile(...a),
}));
const mockDiscoverFiles = jest.fn();
jest.mock("@/lib/platform-scan/static/discover-files", () => ({
  discoverRepoFiles: (...a: unknown[]) => mockDiscoverFiles(...a),
}));
jest.mock("@/lib/platform-scan/discover", () => ({
  discoverRoutes: (...a: unknown[]) => mockDiscover(...a),
  mergeManifest: (...a: unknown[]) => mockMerge(...a),
}));
const mockIsCurated = jest.fn(() => true);
const mockIsVerified = jest.fn(async () => true);
jest.mock("@/lib/platform-scan/manifests", () => ({
  resolveScanTarget: (...a: unknown[]) => mockResolveTarget(...a),
  isCuratedTarget: (...a: unknown[]) => mockIsCurated(...(a as [])),
}));
jest.mock("@/lib/platform-scan/authorization", () => ({
  isTargetVerified: (...a: unknown[]) => mockIsVerified(...(a as [])),
}));
const mockLoadCreds = jest.fn();
const mockEstablish = jest.fn();
const mockProbeApi = jest.fn();
jest.mock("@/lib/assistant/connectors/credentials", () => ({ loadConnectorCredentials: (...a: unknown[]) => mockLoadCreds(...a) }));
const mockEstablishOAuth = jest.fn();
jest.mock("@/lib/platform-scan/session", () => ({ establishSession: (...a: unknown[]) => mockEstablish(...a), establishOAuthPasswordSession: (...a: unknown[]) => mockEstablishOAuth(...a) }));
jest.mock("@/lib/platform-scan/api-probe", () => ({ probeApi: (...a: unknown[]) => mockProbeApi(...a) }));
jest.mock("@/lib/platform-scan/store", () => ({
  recordScan: (...a: unknown[]) => mockRecord(...a),
  listFindings: (...a: unknown[]) => mockList(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue(undefined),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/admin/platform-scans/route";

const STATIC = { owner: "the-wolfpack-agency", repo: "wolfpack-auto", ref: "main", paths: ["src/app/admin/leads/page.tsx"] };
const MANIFEST = {
  baseUrl: "https://target.example",
  routes: [
    { path: "/", journey: "home", auth: "public" as const },
    { path: "/admin", journey: "admin", auth: "required" as const },
  ],
  static: STATIC,
};
const RESULT = {
  platform: "wolfpack-auto",
  baseUrl: "https://target.example",
  routeCount: 2,
  okCount: 1,
  findings: [
    { route: "/admin", severity: "critical" as const, category: "security" as const, title: "Admin served unauthenticated", detail: "200 with no auth", evidence: { status: 200 } },
  ],
};

function post(body?: unknown) {
  return POST(new NextRequest("http://localhost/api/admin/platform-scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  }));
}
function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockResolveTarget.mockResolvedValue({ ...MANIFEST });
  mockScan.mockResolvedValue({ ...RESULT });
  mockScanSource.mockResolvedValue({ ...RESULT });
  mockReadFile.mockReturnValue(async () => null);
  mockDiscoverFiles.mockResolvedValue([]); // no repo-tree files by default -> seed
  mockDiscover.mockResolvedValue([]); // no sitemap routes by default
  mockLoadCreds.mockResolvedValue(null); // no connection -> unauthenticated by default
  mockEstablish.mockResolvedValue(null);
  mockEstablishOAuth.mockResolvedValue(null);
  mockProbeApi.mockResolvedValue([]);
  mockMerge.mockImplementation((seed) => seed); // merge returns the seed
  mockRecord.mockResolvedValue({ scanId: "scan-1", findingCount: 1, criticalCount: 1 });
  mockList.mockResolvedValue([{ id: "f-1", status: "open" }]);
  mockIsCurated.mockReturnValue(true); // default: curated/internal target (exempt)
  mockIsVerified.mockResolvedValue(true);
});

describe("POST /api/admin/platform-scans (http mode)", () => {
  it("discovers + merges routes, runs the engine on the merged set, and persists (200)", async () => {
    mockDiscover.mockResolvedValue([{ path: "/extra", journey: "Extra", auth: "public" }]);
    mockMerge.mockReturnValue(MANIFEST.routes); // merged result the engine should receive

    const res = await post({ platform: "wolfpack-auto" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, platform: "wolfpack-auto", mode: "http", scanId: "scan-1", findings: RESULT.findings });

    expect(mockDiscover).toHaveBeenCalledWith(MANIFEST.baseUrl);
    expect(mockMerge).toHaveBeenCalledWith(MANIFEST.routes, [{ path: "/extra", journey: "Extra", auth: "public" }]);
    expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", platform: "wolfpack-auto", baseUrl: MANIFEST.baseUrl, routes: MANIFEST.routes, authenticated: false }));
    expect(mockRecord).toHaveBeenCalledWith({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin", result: RESULT });
    expect(mockTrack).toHaveBeenCalledWith("platform.scan_started", "admin-1", "admin",
      expect.objectContaining({ platform: "wolfpack-auto", mode: "http", discovered_count: 1 }));
  });

  it("defaults to the wolfpack-auto platform when body has none", async () => {
    await post({});
    expect(mockResolveTarget).toHaveBeenCalledWith("ws-1", "wolfpack-auto");
  });

  it("404s an unknown platform and NEVER runs the engine", async () => {
    mockResolveTarget.mockResolvedValue(null);
    const res = await post({ platform: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_platform" });
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("403s when the capability gate fails (no scan)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await post({ platform: "wolfpack-auto" });
    expect(res.status).toBe(403);
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("403s an onboarded target whose ownership is NOT verified (fail-closed), never runs the engine", async () => {
    mockIsCurated.mockReturnValue(false); // onboarded client target, not curated/internal
    mockIsVerified.mockResolvedValue(false); // ownership not proven
    const res = await post({ platform: "acme-crm" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "unverified_target" });
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.scan_blocked_unverified",
      "admin-1",
      "admin",
      expect.objectContaining({ platform: "acme-crm" }),
    );
  });

  it("proceeds for an onboarded target once ownership IS verified", async () => {
    mockIsCurated.mockReturnValue(false);
    mockIsVerified.mockResolvedValue(true);
    const res = await post({ platform: "acme-crm" });
    expect(res.status).toBe(200);
    expect(mockScan).toHaveBeenCalled();
  });
});

describe("POST /api/admin/platform-scans (static mode)", () => {
  it("runs the source scan over the repo target and persists (seed only when discovery is empty)", async () => {
    const res = await post({ platform: "wolfpack-auto", mode: "static" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "static", scanId: "scan-1" });
    expect(mockDiscoverFiles).toHaveBeenCalledWith(STATIC.owner, STATIC.repo, STATIC.ref);
    expect(mockScanSource).toHaveBeenCalledWith(expect.objectContaining({ platform: "wolfpack-auto", owner: STATIC.owner, repo: STATIC.repo, paths: STATIC.paths }));
    expect(mockScan).not.toHaveBeenCalled(); // http engine not used
    expect(mockRecord).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("platform.scan_started", "admin-1", "admin", expect.objectContaining({ mode: "static" }));
  });

  it("scans the WHOLE discovered surface (union of repo-tree files + seed)", async () => {
    mockDiscoverFiles.mockResolvedValue(["src/app/admin/extra/page.tsx", "src/app/admin/leads/page.tsx"]);
    await post({ platform: "wolfpack-auto", mode: "static" });
    const arg = mockScanSource.mock.calls[0][0];
    // seed ∪ discovered, de-duped.
    expect(arg.paths).toEqual(expect.arrayContaining([...STATIC.paths, "src/app/admin/extra/page.tsx"]));
    expect(new Set(arg.paths).size).toBe(arg.paths.length); // no dupes
    expect(mockTrack).toHaveBeenCalledWith("platform.scan_started", "admin-1", "admin", expect.objectContaining({ mode: "static", discovered_count: 2 }));
  });

  it("400s static mode when the platform has no static target", async () => {
    mockResolveTarget.mockResolvedValue({ baseUrl: MANIFEST.baseUrl, routes: MANIFEST.routes }); // no .static
    const res = await post({ platform: "wolfpack-auto", mode: "static" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_static_target" });
    expect(mockScanSource).not.toHaveBeenCalled();
  });
});

describe("authenticated scan (form-login connection)", () => {
  const LOGIN_MANIFEST = {
    baseUrl: "https://beyond.example",
    routes: MANIFEST.routes,
    login: { connectorName: "wolfpack-beyond", loginPath: "/api/auth/login", sessionCookieName: "session" },
    apiEndpoints: [{ path: "/api/dashboard", method: "GET" as const, journey: "Dashboard", requiresAuth: true }],
  };

  it("http mode logs in and crawls AUTHENTICATED when a username/password connection exists", async () => {
    mockResolveTarget.mockResolvedValue(LOGIN_MANIFEST);
    mockLoadCreds.mockResolvedValue({ authType: "username_password", username: "u@e.com", password: "pw", loginPath: "/api/auth/login", sessionCookieName: "session" });
    mockEstablish.mockResolvedValue({ cookie: "session=abc" });

    await post({ platform: "wolfpack-beyond", mode: "http" });
    expect(mockEstablish).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://beyond.example", username: "u@e.com", password: "pw" }));
    expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ headers: { Cookie: "session=abc" }, authenticated: true }));
    expect(mockTrack).toHaveBeenCalledWith("platform.scan_started", "admin-1", "admin", expect.objectContaining({ authenticated: true }));
  });

  it("falls back to UNauthenticated crawl when no connection is configured", async () => {
    mockResolveTarget.mockResolvedValue(LOGIN_MANIFEST);
    mockLoadCreds.mockResolvedValue(null);
    await post({ platform: "wolfpack-beyond", mode: "http" });
    expect(mockEstablish).not.toHaveBeenCalled();
    expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }));
  });

  it("api mode logs in then runs the gray-box probe and persists", async () => {
    mockResolveTarget.mockResolvedValue(LOGIN_MANIFEST);
    mockLoadCreds.mockResolvedValue({ authType: "username_password", username: "u@e.com", password: "pw", loginPath: "/api/auth/login", sessionCookieName: "session" });
    mockEstablish.mockResolvedValue({ cookie: "session=abc" });
    mockProbeApi.mockResolvedValue([{ route: "/api/dashboard", severity: "critical", category: "security", title: "x", detail: "y", evidence: {} }]);

    const res = await post({ platform: "wolfpack-beyond", mode: "api" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "api", scanId: "scan-1" });
    expect(mockProbeApi).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://beyond.example", authHeaders: { Cookie: "session=abc" }, endpoints: LOGIN_MANIFEST.apiEndpoints }));
    expect(mockScan).not.toHaveBeenCalled(); // http engine not used in api mode
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ findings: expect.any(Array) }) }));
  });

  it("oauth_password (Salesforce): exchanges a token, then probes the INSTANCE url with a bearer", async () => {
    const SF_MANIFEST = {
      baseUrl: "https://test.salesforce.com",
      routes: MANIFEST.routes,
      login: { connectorName: "salesforce-sbx", loginPath: "/services/oauth2/token", sessionCookieName: "" },
      apiEndpoints: [{ path: "/services/data/", method: "GET" as const, journey: "REST root", requiresAuth: true }],
    };
    mockResolveTarget.mockResolvedValue(SF_MANIFEST);
    mockLoadCreds.mockResolvedValue({ authType: "oauth_password", clientId: "cid", clientSecret: "sec", username: "i@acme.com", password: "pw+tok", loginPath: "/services/oauth2/token" });
    mockEstablishOAuth.mockResolvedValue({ authHeader: "Bearer 00Dxx!AR", instanceUrl: "https://acme.my.salesforce.com" });
    mockProbeApi.mockResolvedValue([]);

    const res = await post({ platform: "salesforce-sbx", mode: "api" });
    expect(res.status).toBe(200);
    expect(mockEstablishOAuth).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://test.salesforce.com", clientId: "cid", clientSecret: "sec", username: "i@acme.com" }));
    expect(mockEstablish).not.toHaveBeenCalled(); // not the cookie path
    // Probes the per-org INSTANCE url with the bearer (not the login host).
    expect(mockProbeApi).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://acme.my.salesforce.com", authHeaders: { Authorization: "Bearer 00Dxx!AR" } }));
    expect(mockTrack).toHaveBeenCalledWith("platform.scan_started", "admin-1", "admin", expect.objectContaining({ authenticated: true }));
  });

  it("400s api mode when the platform has no apiEndpoints", async () => {
    mockResolveTarget.mockResolvedValue({ baseUrl: MANIFEST.baseUrl, routes: MANIFEST.routes }); // no apiEndpoints
    const res = await post({ platform: "wolfpack-auto", mode: "api" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_api_endpoints" });
    expect(mockProbeApi).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/platform-scans", () => {
  it("returns the workspace findings from listFindings", async () => {
    const res = await get("http://localhost/api/admin/platform-scans");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ findings: [{ id: "f-1", status: "open" }] });
    expect(mockList).toHaveBeenCalledWith("ws-1", { status: undefined, platform: undefined, severities: undefined });
  });

  it("passes ?status and ?platform through to listFindings", async () => {
    await get("http://localhost/api/admin/platform-scans?status=open&platform=wolfpack-auto");
    expect(mockList).toHaveBeenCalledWith("ws-1", { status: "open", platform: "wolfpack-auto", severities: undefined });
  });

  it("parses ?severity=critical,high into a validated severity subset", async () => {
    await get("http://localhost/api/admin/platform-scans?severity=critical,high");
    expect(mockList).toHaveBeenCalledWith("ws-1", { status: undefined, platform: undefined, severities: ["critical", "high"] });
  });

  it("drops unknown severity tokens; an all-garbage list becomes undefined (all severities)", async () => {
    await get("http://localhost/api/admin/platform-scans?severity=critical,bogus");
    expect(mockList).toHaveBeenCalledWith("ws-1", expect.objectContaining({ severities: ["critical"] }));
    mockList.mockClear();
    await get("http://localhost/api/admin/platform-scans?severity=bogus");
    expect(mockList).toHaveBeenCalledWith("ws-1", expect.objectContaining({ severities: undefined }));
  });

  it("403s when the capability gate fails (no list call)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await get("http://localhost/api/admin/platform-scans");
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});
