/**
 * Tools API route tests — GitHub Actions integration.
 *
 * Validates:
 *   - 401 without auth token
 *   - "not_configured" when GITHUB_TOKEN_TOOLS is unset
 *   - POST triggers workflow dispatch via tools-runner
 *   - GET /api/tools/status returns run status
 *   - trackEvent fires on trigger
 *   - Error handling when GitHub API fails
 *
 * 16 tests across all 4 tool routes + the status endpoint.
 */

 

const mockTrackEvent = jest.fn();
const mockTriggerToolRun = jest.fn();
const mockGetRunStatus = jest.fn();
const mockFetchArtifactResult = jest.fn();
const mockGetLatestToolRun = jest.fn();
let mockIsConfigured = true;

// Mock analytics
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

// Mock DB (requireCapability loads user overrides)
jest.mock("@/lib/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

// Mock triple-write
jest.mock("@/lib/triple-write", () => ({
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock tools-runner
jest.mock("@/lib/tools-runner", () => ({
  triggerToolRun: (...args: any[]) => mockTriggerToolRun(...args),
  getRunStatus: (...args: any[]) => mockGetRunStatus(...args),
  fetchArtifactResult: (...args: any[]) => mockFetchArtifactResult(...args),
  getLatestToolRun: (...args: any[]) => mockGetLatestToolRun(...args),
  isConfigured: () => mockIsConfigured,
}));

import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.INSTINCT_JWT_SECRET ?? process.env.APEX_JWT_SECRET ?? "test-secret-for-dev";

if (!process.env.INSTINCT_JWT_SECRET && !process.env.APEX_JWT_SECRET) {
  process.env.INSTINCT_JWT_SECRET = JWT_SECRET;
}

// Set GITHUB_TOKEN_TOOLS for the test env
process.env.GITHUB_TOKEN_TOOLS = "ghp_test_token_for_ci";

function makeToken(role = "cto") {
  return jwt.sign(
    { userId: "user-1", name: "Test User", email: "test@wolf.co", role, workspace_id: "ws-1" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function authedReq(url: string, opts: { method?: string; body?: string } = {}) {
  const method = opts.method ?? "POST";
  const isGet = method === "GET" || method === "HEAD";
  return new NextRequest(url, {
    method,
    body: isGet ? undefined : (opts.body ?? "{}"),
    headers: {
      authorization: `Bearer ${makeToken()}`,
      "content-type": "application/json",
    },
  });
}

function unauthReq(url: string, opts: { method?: string; body?: string } = {}) {
  const method = opts.method ?? "POST";
  const isGet = method === "GET" || method === "HEAD";
  return new NextRequest(url, {
    method,
    body: isGet ? undefined : (opts.body ?? "{}"),
    headers: { "content-type": "application/json" },
  });
}

async function loadRoute(path: string) {
  jest.resetModules();
  jest.mock("@/lib/analytics", () => ({
    trackEvent: (...args: any[]) => mockTrackEvent(...args),
  }));
  jest.mock("@/lib/db", () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }));
  jest.mock("@/lib/triple-write", () => ({
    tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
  }));
  jest.mock("@/lib/tools-runner", () => ({
    triggerToolRun: (...args: any[]) => mockTriggerToolRun(...args),
    getRunStatus: (...args: any[]) => mockGetRunStatus(...args),
    fetchArtifactResult: (...args: any[]) => mockFetchArtifactResult(...args),
    getLatestToolRun: (...args: any[]) => mockGetLatestToolRun(...args),
    isConfigured: () => mockIsConfigured,
  }));
  return await import(`@/app/api/tools/${path}/route`);
}

const ROUTES = ["pdf-report", "demo-deck", "visual-diff", "accessibility"] as const;

describe("Tools API routes — GitHub Actions integration", () => {
  beforeEach(() => {
    mockTrackEvent.mockClear();
    mockTriggerToolRun.mockClear();
    mockGetRunStatus.mockClear();
    mockFetchArtifactResult.mockClear();
    mockGetLatestToolRun.mockClear();
    mockIsConfigured = true;
  });

  /* ── Auth: 401 without token ──────────────────────────────────── */

  for (const route of ROUTES) {
    it(`POST /api/tools/${route} returns 401 without auth`, async () => {
      const mod = await loadRoute(route);
      const req = unauthReq(`https://localhost/api/tools/${route}`, { method: "POST", body: "{}" });
      const res = await mod.POST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("unauthorized");
    });
  }

  /* ── Not configured (GITHUB_TOKEN_TOOLS missing) ─────────────── */

  for (const route of ROUTES) {
    it(`POST /api/tools/${route} returns not_configured when token missing`, async () => {
      mockIsConfigured = false;
      const mod = await loadRoute(route);
      const req = authedReq(`https://localhost/api/tools/${route}`, { method: "POST", body: "{}" });
      const res = await mod.POST(req);
      const data = await res.json();
      expect(data.status).toBe("not_configured");
      expect(data.message).toContain("contact your admin");
    });
  }

  /* ── Trigger success: workflow dispatched ─────────────────────── */

  it("POST /api/tools/pdf-report triggers workflow and returns run_id", async () => {
    mockTriggerToolRun.mockResolvedValue({ run_id: 12345 });
    const mod = await loadRoute("pdf-report");
    const req = authedReq("https://localhost/api/tools/pdf-report");
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("queued");
    expect(data.run_id).toBe(12345);
    expect(mockTriggerToolRun).toHaveBeenCalledWith(
      "pdf-report",
      expect.objectContaining({ requester: "user-1" }),
      expect.any(String),
    );
  });

  it("POST /api/tools/demo-deck triggers workflow and returns run_id", async () => {
    mockTriggerToolRun.mockResolvedValue({ run_id: 12346 });
    const mod = await loadRoute("demo-deck");
    const req = authedReq("https://localhost/api/tools/demo-deck", {
      body: JSON.stringify({ target_url: "https://example.com" }),
    });
    const res = await mod.POST(req);
    const data = await res.json();
    expect(data.status).toBe("queued");
    expect(data.run_id).toBe(12346);
  });

  it("POST /api/tools/visual-diff triggers workflow with paths", async () => {
    mockTriggerToolRun.mockResolvedValue({ run_id: 12347 });
    const mod = await loadRoute("visual-diff");
    const req = authedReq("https://localhost/api/tools/visual-diff", {
      body: JSON.stringify({ paths: ["/", "/login"] }),
    });
    const res = await mod.POST(req);
    const data = await res.json();
    expect(data.status).toBe("queued");
    expect(data.run_id).toBe(12347);
    expect(mockTriggerToolRun).toHaveBeenCalledWith(
      "visual-diff",
      expect.objectContaining({ paths: "/,/login" }),
      expect.any(String),
    );
  });

  it("POST /api/tools/accessibility triggers workflow with paths", async () => {
    mockTriggerToolRun.mockResolvedValue({ run_id: 12348 });
    const mod = await loadRoute("accessibility");
    const req = authedReq("https://localhost/api/tools/accessibility", {
      body: JSON.stringify({ paths: ["/", "/sites"] }),
    });
    const res = await mod.POST(req);
    const data = await res.json();
    expect(data.status).toBe("queued");
    expect(data.run_id).toBe(12348);
  });

  /* ── Trigger failure: GitHub API error ───────────────────────── */

  it("POST /api/tools/pdf-report returns 500 when trigger fails", async () => {
    mockTriggerToolRun.mockRejectedValue(new Error("GitHub API rate limited"));
    const mod = await loadRoute("pdf-report");
    const req = authedReq("https://localhost/api/tools/pdf-report");
    const res = await mod.POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.status).toBe("failed");
    expect(data.error).toContain("Failed to trigger workflow");
  });

  /* ── trackEvent fires on trigger ─────────────────────────────── */

  it("trackEvent fires with run_id on successful trigger", async () => {
    mockTriggerToolRun.mockResolvedValue({ run_id: 99999 });
    const mod = await loadRoute("pdf-report");
    const req = authedReq("https://localhost/api/tools/pdf-report");
    await mod.POST(req);
    // Find the tools-specific trackEvent call (system.token_verified may also fire)
    const toolCall = mockTrackEvent.mock.calls.find(
      (c: any[]) => c[0] === "tools.pdf_generated",
    );
    expect(toolCall).toBeTruthy();
    expect(toolCall![3]).toMatchObject({ success: true, run_id: 99999 });
  });

  /* ── Status endpoint ─────────────────────────────────────────── */

  it("GET /api/tools/status returns run status by run_id", async () => {
    mockGetRunStatus.mockResolvedValue({ status: "running", run_id: 12345, elapsed_ms: 30000 });
    const mod = await loadRoute("status");
    const req = authedReq("https://localhost/api/tools/status?run_id=12345&tool=pdf-report", { method: "GET" });
    const res = await mod.GET(req);
    const data = await res.json();
    expect(data.status).toBe("running");
    expect(data.run_id).toBe(12345);
  });

  it("GET /api/tools/status returns latest run when only tool provided", async () => {
    mockGetLatestToolRun.mockResolvedValue({
      status: "completed",
      run_id: 11111,
      created_at: "2026-04-16T10:00:00Z",
    });
    mockFetchArtifactResult.mockResolvedValue({ message: "Report generated" });
    const mod = await loadRoute("status");
    const req = authedReq("https://localhost/api/tools/status?tool=pdf-report", { method: "GET" });
    const res = await mod.GET(req);
    const data = await res.json();
    expect(data.status).toBe("completed");
    expect(data.result).toEqual({ message: "Report generated" });
  });

  it("GET /api/tools/status returns 400 for invalid tool", async () => {
    const mod = await loadRoute("status");
    const req = authedReq("https://localhost/api/tools/status?tool=invalid-tool", { method: "GET" });
    const res = await mod.GET(req);
    expect(res.status).toBe(400);
  });

  it("GET /api/tools/status returns not_configured when token missing", async () => {
    mockIsConfigured = false;
    const mod = await loadRoute("status");
    const req = authedReq("https://localhost/api/tools/status?tool=pdf-report", { method: "GET" });
    const res = await mod.GET(req);
    const data = await res.json();
    expect(data.status).toBe("not_configured");
  });
});
