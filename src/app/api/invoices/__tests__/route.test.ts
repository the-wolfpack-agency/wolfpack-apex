/**
 * Contract tests for the Invoices API:
 *   GET  /api/invoices                    -> trackers the caller may view
 *   GET  /api/invoices/{company}          -> one tracker's rows
 *   POST /api/invoices/{company}/refresh  -> force a live re-pull
 *
 * Asserts the full status matrix (401 unauth, 403 not-allowlisted, 404 unknown,
 * 200/502 happy + failure) because a blank UI on a mis-handled 401/403 is a prod
 * bug class this repo has already lived. Access is the per-tracker email
 * allowlist, so the 403 path (authenticated but not a viewer) is covered
 * explicitly, plus that a denial emits the learning event.
 */
export {};

const mockGetUser = jest.fn();
const mockResolveTracker = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
jest.mock("@/lib/invoice-tracker/resolver", () => ({
  resolveTracker: (...a: unknown[]) => mockResolveTracker(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET as GET_LIST } from "../route";
import { GET as GET_ONE } from "../[company]/route";
import { POST as POST_REFRESH } from "../[company]/refresh/route";

function req(path: string, method: "GET" | "POST" = "GET"): NextRequest {
  return new NextRequest(`https://x.test${path}`, {
    method,
    headers: { authorization: "Bearer test" },
  });
}

const params = (company: string) => ({ params: Promise.resolve({ company }) });

const viewer = { id: "u-1", email: "homyk@thewolfpack.agency", role: "cto" };
const stranger = { id: "u-2", email: "stranger@thewolfpack.agency", role: "member" };

const okResult = {
  columns: ["A"],
  rows: [{ A: "1" }],
  source: "fresh" as const,
  lastRefreshedAt: "2026-07-06T00:00:00Z",
  refreshed: true,
  servedStale: false,
  webUrl: "https://host/file",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockTrackEvent.mockResolvedValue(undefined);
});

describe("GET /api/invoices (collection)", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET_LIST(req("/api/invoices"));
    expect(res.status).toBe(401);
  });

  it("returns only the trackers the caller may view", async () => {
    mockGetUser.mockReturnValue(viewer);
    const res = await GET_LIST(req("/api/invoices"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trackers).toEqual([{ id: "pcna", company: "PCNA" }]);
  });

  it("returns an empty list for a non-viewer (no invoice data leaked)", async () => {
    mockGetUser.mockReturnValue(stranger);
    const res = await GET_LIST(req("/api/invoices"));
    const body = await res.json();
    expect(body.trackers).toEqual([]);
  });
});

describe("GET /api/invoices/{company}", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET_ONE(req("/api/invoices/pcna"), params("pcna"));
    expect(res.status).toBe(401);
  });

  it("404 for an unknown tracker", async () => {
    mockGetUser.mockReturnValue(viewer);
    const res = await GET_ONE(req("/api/invoices/nope"), params("nope"));
    expect(res.status).toBe(404);
    expect(mockResolveTracker).not.toHaveBeenCalled();
  });

  it("403 + access_denied event when authenticated but not on the allowlist", async () => {
    mockGetUser.mockReturnValue(stranger);
    const res = await GET_ONE(req("/api/invoices/pcna"), params("pcna"));
    expect(res.status).toBe(403);
    expect(mockResolveTracker).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "invoice_tracker.access_denied",
      "u-2",
      "member",
      expect.objectContaining({ tracker: "pcna" }),
    );
  });

  it("200 with rows + freshness for an approved viewer, and fires viewed", async () => {
    mockGetUser.mockReturnValue(viewer);
    mockResolveTracker.mockResolvedValue(okResult);
    const res = await GET_ONE(req("/api/invoices/pcna"), params("pcna"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      tracker: "pcna",
      company: "PCNA",
      sheet: "Summary",
      columns: ["A"],
      rows: [{ A: "1" }],
      source: "fresh",
      served_stale: false,
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "invoice_tracker.viewed",
      "u-1",
      "cto",
      expect.objectContaining({ tracker: "pcna", rows: 1, source: "fresh" }),
    );
  });
});

describe("POST /api/invoices/{company}/refresh", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST_REFRESH(req("/api/invoices/pcna/refresh", "POST"), params("pcna"));
    expect(res.status).toBe(401);
  });

  it("403 for a non-viewer", async () => {
    mockGetUser.mockReturnValue(stranger);
    const res = await POST_REFRESH(req("/api/invoices/pcna/refresh", "POST"), params("pcna"));
    expect(res.status).toBe(403);
  });

  it("404 for an unknown tracker", async () => {
    mockGetUser.mockReturnValue(viewer);
    const res = await POST_REFRESH(req("/api/invoices/nope/refresh", "POST"), params("nope"));
    expect(res.status).toBe(404);
  });

  it("200 with fresh rows on success", async () => {
    mockGetUser.mockReturnValue(viewer);
    mockResolveTracker.mockResolvedValue(okResult);
    const res = await POST_REFRESH(req("/api/invoices/pcna/refresh", "POST"), params("pcna"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("fresh");
    expect(body.rows).toEqual([{ A: "1" }]);
  });

  it("502 when a cold-cache refresh cannot reach Graph (surfaced, not silent-empty)", async () => {
    mockGetUser.mockReturnValue(viewer);
    mockResolveTracker.mockResolvedValue({
      columns: [],
      rows: [],
      source: "empty",
      lastRefreshedAt: null,
      refreshed: false,
      servedStale: false,
      errorCode: "no_token",
      webUrl: null,
    });
    const res = await POST_REFRESH(req("/api/invoices/pcna/refresh", "POST"), params("pcna"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("refresh_failed");
    expect(body.error_code).toBe("no_token");
  });
});
