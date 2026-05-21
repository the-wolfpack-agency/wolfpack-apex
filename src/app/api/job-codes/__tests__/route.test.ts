/**
 * Contract tests for /api/job-codes (GET) and /api/job-codes/refresh (POST).
 *
 * Asserts:
 *   - Both endpoints require the right capability (401/403 on missing).
 *   - GET returns the JobCode array + freshness metadata.
 *   - GET returns 503 when the cache is cold AND Graph just failed
 *     (we DON'T want a green 200 + empty array — that silently breaks
 *     the TimeLogWidget dropdown without surfacing the cause).
 *   - POST refresh writes the outcome and surfaces a 502 on failure
 *     so the admin sees the error chip instead of a green "Refreshed".
 *   - POST refresh enforces a 30-second per-user cooldown.
 */

export {};

const mockRequireCapability = jest.fn();
const mockResolveJobCodes = jest.fn();
const mockForceRefresh = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetOrderedCols = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/job-codes/resolver", () => ({
  resolveJobCodes: (...a: unknown[]) => mockResolveJobCodes(...a),
  forceRefresh: (...a: unknown[]) => mockForceRefresh(...a),
}));
jest.mock("@/lib/job-codes/repo", () => ({
  getLatestOrderedColumns: (...a: unknown[]) => mockGetOrderedCols(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET as GET_LIST } from "../route";
import { POST as POST_REFRESH } from "../refresh/route";

function makeReq(path: string, method: "GET" | "POST" = "GET"): NextRequest {
  return new NextRequest(`https://x.test${path}`, {
    method,
    headers: { authorization: "Bearer test" },
  });
}

const okAuth = (overrides: { id?: string; role?: string } = {}) => ({
  ok: true,
  user: { id: overrides.id ?? "u-1", role: overrides.role ?? "ops" },
  capabilities: new Set(),
});

const sampleRows = [
  { code: "A-1", description: "Alpha", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20", extra: { "Program": "P1", "PO Number": "PO-1" } },
];

beforeEach(() => {
  jest.resetAllMocks();
  mockTrackEvent.mockResolvedValue(undefined);
  mockGetOrderedCols.mockResolvedValue(null);
});

describe("GET /api/job-codes", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET_LIST(makeReq("/api/job-codes"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with codes + freshness on the happy path", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockResolveJobCodes.mockResolvedValue({
      rows: sampleRows,
      source: {
        driveId: "d",
        itemId: "i",
        webUrl: "u",
        sheetName: "Job Codes",
        lastRefreshedAt: "2026-05-20T20:00:00Z",
        lastAttemptedAt: "2026-05-20T20:00:00Z",
        lastAttemptStatus: "succeeded",
        lastAttemptError: null,
      },
      refreshed: false,
      servedStale: false,
      refreshOutcome: null,
    });
    const res = await GET_LIST(makeReq("/api/job-codes"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.codes).toEqual(sampleRows);
    expect(body.source.sheetName).toBe("Job Codes");
    expect(body.served_stale).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.viewed",
      "u-1",
      "ops",
      expect.objectContaining({ row_count: 1, refreshed: false, served_stale: false }),
    );
  });

  it("returns 503 when cache is cold AND Graph just failed", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockResolveJobCodes.mockResolvedValue({
      rows: [],
      source: {
        driveId: null,
        itemId: null,
        webUrl: null,
        sheetName: null,
        lastRefreshedAt: null,
        lastAttemptedAt: new Date().toISOString(),
        lastAttemptStatus: "failed",
        lastAttemptError: "no token",
      },
      refreshed: true,
      servedStale: false,
      refreshOutcome: {
        status: "failed",
        source: "auto_stale",
        rowsSeen: 0,
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsDeactivated: 0,
        startedAt: "x",
        finishedAt: "x",
        error: { code: "not_configured", detail: "no token" },
      },
    });
    const res = await GET_LIST(makeReq("/api/job-codes"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("job_codes_unavailable");
  });
});

describe("POST /api/job-codes/refresh", () => {
  it("returns 403 when caller lacks jobcodes.refresh", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await POST_REFRESH(makeReq("/api/job-codes/refresh", "POST"));
    expect(res.status).toBe(403);
  });

  it("returns 200 with outcome on success", async () => {
    mockRequireCapability.mockResolvedValue(okAuth({ id: "admin-1", role: "cto" }));
    mockForceRefresh.mockResolvedValue({
      status: "succeeded",
      source: "manual",
      rowsSeen: 3,
      rowsAdded: 1,
      rowsUpdated: 2,
      rowsDeactivated: 0,
      startedAt: "x",
      finishedAt: "y",
    });
    const res = await POST_REFRESH(makeReq("/api/job-codes/refresh", "POST"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome.rowsAdded).toBe(1);
  });

  it("returns 502 when the refresh fails", async () => {
    mockRequireCapability.mockResolvedValue(okAuth({ id: "admin-2", role: "cto" }));
    mockForceRefresh.mockResolvedValue({
      status: "failed",
      source: "manual",
      rowsSeen: 0,
      rowsAdded: 0,
      rowsUpdated: 0,
      rowsDeactivated: 0,
      startedAt: "x",
      finishedAt: "y",
      error: { code: "graph_unavailable", detail: "503" },
    });
    const res = await POST_REFRESH(makeReq("/api/job-codes/refresh", "POST"));
    expect(res.status).toBe(502);
  });

  it("rate-limits a second refresh within 30 seconds (per user)", async () => {
    mockRequireCapability.mockResolvedValue(okAuth({ id: "admin-3", role: "cto" }));
    mockForceRefresh.mockResolvedValue({
      status: "succeeded",
      source: "manual",
      rowsSeen: 1,
      rowsAdded: 1,
      rowsUpdated: 0,
      rowsDeactivated: 0,
      startedAt: "x",
      finishedAt: "y",
    });
    const first = await POST_REFRESH(makeReq("/api/job-codes/refresh", "POST"));
    expect(first.status).toBe(200);
    const second = await POST_REFRESH(makeReq("/api/job-codes/refresh", "POST"));
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retry_after_sec).toBeGreaterThan(0);
  });
});
