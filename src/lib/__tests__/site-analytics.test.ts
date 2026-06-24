/**
 * site-analytics lib: recordSiteEvent persists one row; getSiteAnalyticsSummary
 * shapes the aggregate rows the admin page renders. DB is mocked.
 */

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  recordSiteEvent,
  getSiteAnalyticsSummary,
  isSiteEventType,
} from "@/lib/site-analytics";

const ORIGINAL_DB = process.env.DATABASE_URL;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB;
});

describe("isSiteEventType", () => {
  it("accepts the closed vocabulary and rejects others", () => {
    expect(isSiteEventType("site.page_viewed")).toBe(true);
    expect(isSiteEventType("site.cta_clicked")).toBe(true);
    expect(isSiteEventType("site.evil")).toBe(false);
    expect(isSiteEventType(42)).toBe(false);
  });
});

describe("recordSiteEvent", () => {
  it("inserts an anonymous row with the given fields", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await recordSiteEvent({
      eventType: "site.page_viewed",
      path: "/ogiam-iam",
      country: "US",
      referrerHost: "google.com",
      props: { surface: "dropdown" },
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBe("site.page_viewed");
    expect(params[1]).toBe("/ogiam-iam");
    expect(params[2]).toBe("US");
    expect(params[3]).toBe("google.com");
    expect(JSON.parse(params[4])).toEqual({ surface: "dropdown" });
  });

  it("is a no-op without DATABASE_URL and never throws", async () => {
    delete process.env.DATABASE_URL;
    await expect(recordSiteEvent({ eventType: "site.page_viewed" })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("getSiteAnalyticsSummary", () => {
  it("aggregates rows into the heatmap + breakdown shapes", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ hour: 9, count: "12" }, { hour: 14, count: "30" }] }) // byHour
      .mockResolvedValueOnce({ rows: [{ path: "/ogiam-iam", count: "40" }] }) // byPage
      .mockResolvedValueOnce({ rows: [{ country: "US", count: "35" }] }) // byCountry
      .mockResolvedValueOnce({ rows: [{ event_type: "site.page_viewed", count: "42" }] }) // byType
      .mockResolvedValueOnce({ rows: [{ page_views: "42", total: "55" }] }); // totals

    const summary = await getSiteAnalyticsSummary(30);
    expect(summary.rangeDays).toBe(30);
    expect(summary.totalPageViews).toBe(42);
    expect(summary.totalEvents).toBe(55);
    expect(summary.byHour).toEqual([
      { hour: 9, count: 12 },
      { hour: 14, count: 30 },
    ]);
    expect(summary.byPage).toEqual([{ path: "/ogiam-iam", count: 40 }]);
    expect(summary.byCountry).toEqual([{ country: "US", count: 35 }]);
    expect(summary.byType).toEqual([{ type: "site.page_viewed", count: 42 }]);
  });

  it("clamps the range to a sane window", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const summary = await getSiteAnalyticsSummary(99999);
    expect(summary.rangeDays).toBe(365);
    // The clamped value is passed to SQL as a string param.
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["365"]);
  });
});
