/**
 * Contract for /api/admin/compliance-scan.
 *
 * The interesting assertions are the ones about what a caller CANNOT make this
 * route do. A scan route takes a target and fetches it, which is a
 * request-forgery surface if the caller gets to choose the host. Every test
 * about `path` exists to prove they do not.
 *
 * 200 / 400 / 401 / 403 / 404 are all asserted. A blank page caused by an
 * unasserted 401 is a bug class this codebase has already lived through.
 */
const mockResolveTarget = jest.fn();
const mockCurated = jest.fn();
const mockVerified = jest.fn();
const mockRun = jest.fn();
const mockList = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/manifests", () => ({
  resolveScanTarget: (...a: unknown[]) => mockResolveTarget(...a),
  isCuratedTarget: (...a: unknown[]) => mockCurated(...a),
}));
jest.mock("@/lib/platform-scan/authorization", () => ({ isTargetVerified: (...a: unknown[]) => mockVerified(...a) }));
jest.mock("@/lib/platform-scan/compliance/run", () => ({ runSiteScan: (...a: unknown[]) => mockRun(...a) }));
jest.mock("@/lib/platform-scan/anomaly/store", () => ({ listAnomalyRuns: (...a: unknown[]) => mockList(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({}),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const REPORT = {
  pageUrl: "https://client.example.com/",
  finalUrl: "https://client.example.com/",
  tier: "static",
  findings: [],
  summary: { total: 0, present: 0, absent: 0, unverifiable: 0, worstAbsent: null, headline: "" },
  anomaly: { findings: [], disappeared: [], caveats: [], totals: { thirdParties: 0, unexplained: 0, novel: 0 } },
  runId: "run-1",
  baselineUpdated: true,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/compliance-scan", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockResolveTarget.mockResolvedValue({ baseUrl: "https://client.example.com" });
  mockCurated.mockReturnValue(false);
  mockVerified.mockResolvedValue(true);
  mockRun.mockResolvedValue({ ok: true, report: REPORT });
  mockList.mockResolvedValue([]);
});

describe("POST", () => {
  it("returns 200 and the report for a verified target", async () => {
    const res = await POST(post({ platform: "client-site", path: "/pricing" }));
    expect(res.status).toBe(200);
    expect((await res.json()).report.runId).toBe("run-1");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(post({ platform: "x" }))).status).toBe(401);
  });

  it("returns 403 when the target is not ownership-verified, without scanning", async () => {
    // The floor that stops an operator typo from scanning a system nobody
    // authorized.
    mockVerified.mockResolvedValue(false);
    const res = await POST(post({ platform: "someone-elses-site" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("target_not_verified");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("records the refusal to the audit log and to analytics", async () => {
    mockVerified.mockResolvedValue(false);
    await POST(post({ platform: "someone-elses-site" }));
    expect(mockTrack).toHaveBeenCalledWith("platform.scan_blocked_unverified", "admin-1", "admin", expect.any(Object));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "platform.compliance_scan.blocked" }));
  });

  it("allows a curated target without an ownership check", async () => {
    mockCurated.mockReturnValue(true);
    expect((await POST(post({ platform: "wolfpack-auto" }))).status).toBe(200);
    expect(mockVerified).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown target", async () => {
    mockResolveTarget.mockResolvedValue(null);
    expect((await POST(post({ platform: "nope" }))).status).toBe(404);
  });

  it("returns 400 with no platform", async () => {
    expect((await POST(post({}))).status).toBe(400);
  });

  it("returns 400 rather than 500 on a malformed body", async () => {
    const req = new NextRequest("http://localhost/api/admin/compliance-scan", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("surfaces a gate refusal as 403", async () => {
    mockRun.mockResolvedValue({ ok: false, reason: "kill_switch_engaged" });
    const res = await POST(post({ platform: "client-site" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("kill_switch_engaged");
  });
});

describe("the caller cannot choose the host", () => {
  async function urlScannedFor(path: unknown): Promise<string> {
    await POST(post({ platform: "client-site", path }));
    return mockRun.mock.calls[0][0].pageUrl;
  }

  it("builds the URL from the manifest, not from the request", async () => {
    expect(await urlScannedFor("/pricing")).toBe("https://client.example.com/pricing");
  });

  it("ignores an absolute URL pointing at another host", async () => {
    // Without this, an authenticated user could aim the scanner at anything.
    expect(await urlScannedFor("https://evil.example.net/")).toBe("https://client.example.com/");
  });

  it("ignores a protocol-relative host", async () => {
    expect(await urlScannedFor("//evil.example.net/")).toBe("https://client.example.com/");
  });

  it("rejects a non-string path rather than guessing what was meant", async () => {
    // Silently substituting the root would turn a bug in a caller into a scan
    // of the wrong page that nobody notices.
    const res = await POST(post({ platform: "client-site", path: 42 }));
    expect(res.status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("defaults to the root when no path is given", async () => {
    expect(await urlScannedFor(undefined)).toBe("https://client.example.com/");
  });
});

describe("GET", () => {
  it("returns previous runs for a target", async () => {
    mockList.mockResolvedValue([{ id: "run-1" }]);
    const res = await GET(new NextRequest("http://localhost/api/admin/compliance-scan?platform=client-site"));
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toHaveLength(1);
  });

  it("scopes the read to the caller's workspace", async () => {
    await GET(new NextRequest("http://localhost/api/admin/compliance-scan?platform=client-site"));
    expect(mockList).toHaveBeenCalledWith("ws-1", "client-site", 20);
  });

  it("returns 400 without a platform", async () => {
    expect((await GET(new NextRequest("http://localhost/api/admin/compliance-scan"))).status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET(new NextRequest("http://localhost/api/admin/compliance-scan?platform=x"))).status).toBe(401);
  });
});
