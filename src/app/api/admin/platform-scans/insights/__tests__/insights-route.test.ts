/**
 * Contract for /api/admin/platform-scans/insights.
 *
 * POST correlates the full open finding corpus into cross-scan insights, persists
 * them, fires the learning events, audits the run, and returns the insights. GET
 * returns the recent insights for the dashboard. Dual auth (cron bearer OR the
 * settings.manage_team capability) + the 401/403 paths are exercised.
 *
 * The correlate engine is REAL (the insight path is proven end-to-end on the
 * findings we feed in); only db (listFindings), persistence, analytics, and audit
 * are mocked, so no DB is touched.
 */
const mockListFindings = jest.fn();
const mockTrack = jest.fn();
const mockRecord = jest.fn();
const mockListRecent = jest.fn();
const mockRecordAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => mockAuth(),
}));
jest.mock("@/lib/platform-scan/store", () => ({
  listFindings: (...a: unknown[]) => mockListFindings(...a),
}));
jest.mock("@/lib/platform-scan/insights/insights-store", () => ({
  recordInsights: (...a: unknown[]) => mockRecord(...a),
  listRecentInsights: (...a: unknown[]) => mockListRecent(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "req-1" }),
}));
// correlate engine is REAL (not mocked) so the end-to-end insight path is proven.

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/admin/platform-scans/insights/route";

function findingRow(category: string, title: string, route: string, platform = "acme", severity = "high") {
  return {
    id: `f_${title}`,
    scanId: "s1",
    platform,
    route,
    severity,
    category,
    title,
    detail: "",
    evidence: {},
    status: "open",
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function makePost(headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/insights", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}
function makeGet(headers: Record<string, string> = {}, qs = "") {
  return GET(
    new NextRequest(`http://localhost/api/admin/platform-scans/insights${qs}`, {
      method: "GET",
      headers,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockRecord.mockResolvedValue({ written: 1 });
  mockListRecent.mockResolvedValue([]);
  mockRecordAudit.mockResolvedValue({ ok: true });
  mockListFindings.mockResolvedValue([]);
});

describe("POST (generate insights)", () => {
  test("reads the open corpus, persists, fires events, audits, returns 200 with insights", async () => {
    // A compound risk: two modalities on the same route.
    mockListFindings.mockResolvedValue([
      findingRow("security", "Missing CSRF", "/checkout"),
      findingRow("broken_journey", "Payment 500", "/checkout", "acme", "medium"),
    ]);

    const res = await makePost();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.insights)).toBe(true);
    expect(body.insights.some((i: { kind: string }) => i.kind === "compound_risk")).toBe(true);

    // Persisted + analytics + audit all fired.
    expect(mockRecord).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.cross_scan_insight_generated",
      "admin-1",
      "admin",
      expect.any(Object),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.cross_scan_insights_generated" }),
    );
  });

  test("CI cron bearer path authorizes without a capability check", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await makePost({ authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
    // Reads the DEFAULT workspace for the anonymous agent path.
    expect(mockListFindings).toHaveBeenCalledWith("default", { status: "open", limit: 500 });
  });

  test("401/403 when neither cron nor capability authorizes", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await makePost(); // no bearer
    expect(res.status).toBe(401);
  });
});

describe("GET (list recent insights)", () => {
  test("returns 200 with the recent insights for the dashboard", async () => {
    mockListRecent.mockResolvedValue([
      { id: "xins_1", kind: "compound_risk", severity: "critical", platform: "acme", modalities: [], members: [], narrative: "n", status: "open", key: "k", generatedAt: "2026-06-28T00:00:00.000Z" },
    ]);
    const res = await makeGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insights).toHaveLength(1);
  });

  test("403 when the capability check fails", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await makeGet();
    expect(res.status).toBe(403);
  });
});
