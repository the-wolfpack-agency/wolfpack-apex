/**
 * Unit tests for the cache-aware resolver.
 *
 * We mock the four collaborators (repo + sharepoint-source + analytics)
 * so the tests focus on the staleness policy, the served-stale
 * fallback, and the refresh outcome shape.
 */

const mockListActive = jest.fn();
const mockGetSourceInfo = jest.fn();
const mockReplaceJobCodes = jest.fn();
const mockRecordRefreshOutcome = jest.fn();
const mockFetchFromSharePoint = jest.fn();

jest.mock("@/lib/job-codes/repo", () => ({
  listActiveJobCodes: (...a: unknown[]) => mockListActive(...a),
  getSourceInfo: (...a: unknown[]) => mockGetSourceInfo(...a),
  replaceJobCodes: (...a: unknown[]) => mockReplaceJobCodes(...a),
  recordRefreshOutcome: (...a: unknown[]) => mockRecordRefreshOutcome(...a),
}));
jest.mock("@/lib/job-codes/sharepoint-source", () => ({
  fetchJobCodesFromSharePoint: (...a: unknown[]) => mockFetchFromSharePoint(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn().mockResolvedValue(undefined),
}));

import { resolveJobCodes } from "@/lib/job-codes/resolver";

const freshSource = {
  driveId: "d",
  itemId: "i",
  webUrl: "https://x.sharepoint.com/x.xlsx",
  sheetName: "Job Codes",
  lastRefreshedAt: new Date().toISOString(), // just now → fresh
  lastAttemptedAt: new Date().toISOString(),
  lastAttemptStatus: "succeeded" as const,
  lastAttemptError: null,
};

const staleSource = {
  ...freshSource,
  lastRefreshedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h old → stale
  lastAttemptedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
};

const sampleCacheRows = [
  { code: "A-1", description: "Alpha", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
  { code: "B-2", description: "Beta", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
];

const sampleFreshRows = [
  { code: "A-1", description: "Alpha", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
  { code: "B-2", description: "Beta", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
  { code: "C-3", description: "Gamma", sheetName: "Job Codes", active: true, lastSeenAt: "2026-05-20" },
];

beforeEach(() => {
  jest.resetAllMocks();
  mockRecordRefreshOutcome.mockResolvedValue({});
});

describe("resolveJobCodes — staleness policy", () => {
  it("serves the cache and skips Graph when fresh", async () => {
    mockGetSourceInfo.mockResolvedValue(freshSource);
    mockListActive.mockResolvedValue(sampleCacheRows);

    const res = await resolveJobCodes();
    expect(res.rows.length).toBe(2);
    expect(res.refreshed).toBe(false);
    expect(res.servedStale).toBe(false);
    expect(mockFetchFromSharePoint).not.toHaveBeenCalled();
  });

  it("triggers a refresh when the cache is cold (empty)", async () => {
    mockGetSourceInfo.mockResolvedValue({ ...freshSource, lastRefreshedAt: null });
    mockListActive.mockResolvedValueOnce([]).mockResolvedValueOnce(sampleFreshRows);
    mockFetchFromSharePoint.mockResolvedValue({
      ok: true,
      value: { rows: sampleFreshRows, driveId: "d", itemId: "i", webUrl: "u", sheetName: "Job Codes" },
    });
    mockReplaceJobCodes.mockResolvedValue({ added: 3, updated: 0, deactivated: 0 });

    const res = await resolveJobCodes();
    expect(mockFetchFromSharePoint).toHaveBeenCalled();
    expect(res.refreshed).toBe(true);
    expect(res.rows.length).toBe(3);
  });

  it("triggers a refresh when the cache is stale", async () => {
    mockGetSourceInfo.mockResolvedValue(staleSource);
    mockListActive.mockResolvedValueOnce(sampleCacheRows).mockResolvedValueOnce(sampleFreshRows);
    mockFetchFromSharePoint.mockResolvedValue({
      ok: true,
      value: { rows: sampleFreshRows, driveId: "d", itemId: "i", webUrl: "u", sheetName: "Job Codes" },
    });
    mockReplaceJobCodes.mockResolvedValue({ added: 1, updated: 2, deactivated: 0 });

    const res = await resolveJobCodes();
    expect(mockFetchFromSharePoint).toHaveBeenCalled();
    expect(res.refreshed).toBe(true);
    expect(res.servedStale).toBe(false);
    expect(res.rows.length).toBe(3);
  });
});

describe("resolveJobCodes — served-stale fallback", () => {
  it("serves cached rows + sets servedStale=true when Graph refresh fails", async () => {
    mockGetSourceInfo.mockResolvedValue(staleSource);
    mockListActive.mockResolvedValue(sampleCacheRows);
    mockFetchFromSharePoint.mockResolvedValue({
      ok: false,
      error: { code: "graph_unavailable", detail: "503" },
    });

    const res = await resolveJobCodes();
    expect(res.servedStale).toBe(true);
    expect(res.rows).toEqual(sampleCacheRows);
    expect(res.refreshOutcome?.status).toBe("failed");
  });

  it("returns empty + non-stale when cold AND Graph fails (no fallback content)", async () => {
    mockGetSourceInfo.mockResolvedValue({ ...freshSource, lastRefreshedAt: null });
    mockListActive.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockFetchFromSharePoint.mockResolvedValue({
      ok: false,
      error: { code: "not_configured", detail: "no token" },
    });

    const res = await resolveJobCodes();
    expect(res.rows).toEqual([]);
    expect(res.servedStale).toBe(false);
    expect(res.refreshOutcome?.status).toBe("failed");
  });
});

describe("resolveJobCodes — forceRefresh", () => {
  it("re-pulls Graph even when cache is fresh", async () => {
    mockGetSourceInfo.mockResolvedValue(freshSource);
    mockListActive.mockResolvedValueOnce(sampleCacheRows).mockResolvedValueOnce(sampleFreshRows);
    mockFetchFromSharePoint.mockResolvedValue({
      ok: true,
      value: { rows: sampleFreshRows, driveId: "d", itemId: "i", webUrl: "u", sheetName: "Job Codes" },
    });
    mockReplaceJobCodes.mockResolvedValue({ added: 1, updated: 2, deactivated: 0 });

    const res = await resolveJobCodes({ forceRefresh: true, triggeredBy: "u-1", refreshSource: "manual" });
    expect(mockFetchFromSharePoint).toHaveBeenCalled();
    expect(res.refreshed).toBe(true);
    expect(res.refreshOutcome?.status).toBe("succeeded");
    expect(res.refreshOutcome?.source).toBe("manual");
  });
});
