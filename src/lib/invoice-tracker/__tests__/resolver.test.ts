/**
 * Resolver staleness-policy tests. The resolver is the one place that decides
 * cache-vs-refresh and MUST NEVER throw (a finance page cannot blank on a
 * transient Graph error), so every branch is covered: fresh-cache-hit,
 * cold-refresh-success, forced-refresh, serve-stale-on-failure, and
 * cold-cache-failure. Also asserts the learning events fire.
 */
export {};

const mockGetSnapshot = jest.fn();
const mockSaveSnapshot = jest.fn();
const mockRecordAttempt = jest.fn();
const mockFetchSheet = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("../repo", () => ({
  getSnapshot: (...a: unknown[]) => mockGetSnapshot(...a),
  saveSnapshot: (...a: unknown[]) => mockSaveSnapshot(...a),
  recordAttempt: (...a: unknown[]) => mockRecordAttempt(...a),
}));
jest.mock("../sharepoint-source", () => ({
  fetchSheet: (...a: unknown[]) => mockFetchSheet(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { resolveTracker } from "../resolver";
import type { InvoiceTracker } from "../config";

const TRACKER: InvoiceTracker = {
  id: "pcna",
  company: "PCNA",
  sheet: "Summary",
  shareUrlEnv: "INVOICE_TRACKER_PCNA_SHARE_URL",
  defaultShareUrl: "https://host/share",
  viewers: ["homyk@thewolfpack.agency"],
};

const okFetch = {
  ok: true,
  value: {
    columns: ["A"],
    rows: [{ A: "1" }],
    driveId: "d",
    itemId: "i",
    webUrl: "https://host/file",
    sheetName: "Summary",
    tokenKind: "delegated" as const,
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockSaveSnapshot.mockResolvedValue(undefined);
  mockRecordAttempt.mockResolvedValue(undefined);
  mockTrackEvent.mockResolvedValue(undefined);
});

function snap(overrides: Record<string, unknown> = {}) {
  return {
    trackerId: "pcna",
    columns: ["A"],
    rows: [{ A: "cached" }],
    driveId: "d",
    itemId: "i",
    webUrl: "https://host/file",
    sheetName: "Summary",
    lastRefreshedAt: new Date().toISOString(),
    lastAttemptedAt: new Date().toISOString(),
    lastAttemptStatus: "succeeded",
    lastAttemptError: null,
    ...overrides,
  };
}

describe("resolveTracker", () => {
  it("serves the cache without a Graph call when fresh", async () => {
    mockGetSnapshot.mockResolvedValue(snap());
    const r = await resolveTracker({ tracker: TRACKER, triggeredBy: "u-1" });
    expect(r.source).toBe("cache");
    expect(r.rows).toEqual([{ A: "cached" }]);
    expect(mockFetchSheet).not.toHaveBeenCalled();
  });

  it("refreshes from Graph on a cold cache, saves the snapshot and fires refreshed", async () => {
    mockGetSnapshot.mockResolvedValue(null);
    mockFetchSheet.mockResolvedValue(okFetch);
    const r = await resolveTracker({ tracker: TRACKER, triggeredBy: "u-1", triggeredByRole: "cto" });
    expect(r.source).toBe("fresh");
    expect(r.refreshed).toBe(true);
    expect(r.rows).toEqual([{ A: "1" }]);
    expect(mockSaveSnapshot).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "invoice_tracker.refreshed",
      "u-1",
      "cto",
      expect.objectContaining({ tracker: "pcna", rows: 1, token_kind: "delegated" }),
    );
  });

  it("forces a refresh even when the cache is fresh", async () => {
    mockGetSnapshot.mockResolvedValue(snap());
    mockFetchSheet.mockResolvedValue(okFetch);
    const r = await resolveTracker({ tracker: TRACKER, triggeredBy: "u-1", forceRefresh: true });
    expect(mockFetchSheet).toHaveBeenCalledTimes(1);
    expect(r.source).toBe("fresh");
  });

  it("refreshes when the snapshot is stale (older than the TTL)", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockGetSnapshot.mockResolvedValue(snap({ lastRefreshedAt: old }));
    mockFetchSheet.mockResolvedValue(okFetch);
    const r = await resolveTracker({ tracker: TRACKER, triggeredBy: "u-1" });
    expect(mockFetchSheet).toHaveBeenCalled();
    expect(r.source).toBe("fresh");
  });

  it("serves the stale snapshot and flags it when a refresh fails", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockGetSnapshot.mockResolvedValue(snap({ lastRefreshedAt: old }));
    mockFetchSheet.mockResolvedValue({ ok: false, error: { code: "graph_error", detail: "500" } });
    const r = await resolveTracker({ tracker: TRACKER, triggeredBy: "u-1" });
    expect(r.source).toBe("stale");
    expect(r.servedStale).toBe(true);
    expect(r.errorCode).toBe("graph_error");
    expect(r.rows).toEqual([{ A: "cached" }]);
    expect(mockRecordAttempt).toHaveBeenCalledWith("pcna", "served_stale", "500");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "invoice_tracker.refresh_failed",
      "u-1",
      "unknown",
      expect.objectContaining({ error_code: "graph_error", served_stale: true }),
    );
  });

  it("returns empty with an error code when the cache is cold AND Graph fails", async () => {
    mockGetSnapshot.mockResolvedValue(null);
    mockFetchSheet.mockResolvedValue({ ok: false, error: { code: "no_token", detail: "no token" } });
    const r = await resolveTracker({ tracker: TRACKER, triggeredBy: "u-1" });
    expect(r.source).toBe("empty");
    expect(r.rows).toEqual([]);
    expect(r.errorCode).toBe("no_token");
    expect(mockRecordAttempt).toHaveBeenCalledWith("pcna", "failed", "no token");
  });

  it("does not throw even if recordAttempt rejects", async () => {
    mockGetSnapshot.mockResolvedValue(null);
    mockFetchSheet.mockResolvedValue({ ok: false, error: { code: "forbidden", detail: "403" } });
    mockRecordAttempt.mockRejectedValue(new Error("db down"));
    await expect(resolveTracker({ tracker: TRACKER, triggeredBy: "u-1" })).resolves.toMatchObject({
      source: "empty",
      errorCode: "forbidden",
    });
  });
});
