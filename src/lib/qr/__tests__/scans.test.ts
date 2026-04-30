/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  query: jest.fn(),
}));

import {
  parseUserAgent,
  visitorHash,
  recordScan,
  getAnalytics,
} from "@/lib/qr/scans";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("parseUserAgent", () => {
  test.each([
    [
      "iPhone Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      "mobile",
      "iOS",
      "Safari",
    ],
    [
      "Windows Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "desktop",
      "Windows",
      "Chrome",
    ],
    [
      "Mac Firefox",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
      "desktop",
      "Mac",
      "Firefox",
    ],
    [
      "Android Chrome Mobile",
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "mobile",
      "Android",
      "Chrome",
    ],
    [
      "iPad Safari",
      "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      "tablet",
      "iOS",
      "Safari",
    ],
    [
      "Googlebot",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "bot",
      "unknown",
      "unknown",
    ],
    [
      "Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.61",
      "desktop",
      "Windows",
      "Edge",
    ],
    ["empty UA", "", "unknown", "unknown", "unknown"],
    ["null UA", null, "unknown", "unknown", "unknown"],
  ])("%s", (_label, ua, device, os, browser) => {
    const r = parseUserAgent(ua as string | null);
    expect(r.device).toBe(device);
    expect(r.os).toBe(os);
    expect(r.browser).toBe(browser);
  });
});

describe("visitorHash", () => {
  test("deterministic for same IP+UA", () => {
    const a = visitorHash("1.2.3.4", "Mozilla");
    const b = visitorHash("1.2.3.4", "Mozilla");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });
  test("differs across distinct inputs", () => {
    expect(visitorHash("1.2.3.4", "Mozilla")).not.toBe(
      visitorHash("1.2.3.5", "Mozilla"),
    );
    expect(visitorHash("1.2.3.4", "Mozilla")).not.toBe(
      visitorHash("1.2.3.4", "Chrome"),
    );
  });
});

describe("recordScan", () => {
  test("inserts hashed visitor + parsed UA", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const headers = new Headers({
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Safari/604.1",
      "x-forwarded-for": "203.0.113.7",
      referer: "https://twitter.com/share",
    });
    await recordScan({ codeId: "code-1", headers });
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params[0]).toBe("code-1");
    expect(params[1]).toHaveLength(16); // visitor hash
    expect(params[5]).toBe("mobile"); // device
    expect(params[6]).toBe("iOS"); // os
    expect(params[8]).toBe("https://twitter.com/share"); // referrer
    expect(params[9]).toBe(false); // blocked default
  });
  test("respects blocked=true and geo overrides", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await recordScan({
      codeId: "code-1",
      blocked: true,
      headers: new Headers(),
      geo: { country: "US", region: "CA", city: "San Francisco" },
    });
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params[2]).toBe("US");
    expect(params[3]).toBe("CA");
    expect(params[4]).toBe("San Francisco");
    expect(params[9]).toBe(true);
  });
  test("missing codeId is a no-op", async () => {
    await recordScan({ codeId: "", headers: new Headers() });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
  test("DB error swallowed (best-effort)", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(
      recordScan({ codeId: "code-1", headers: new Headers() }),
    ).resolves.toBeUndefined();
  });
});

describe("getAnalytics", () => {
  test("returns zeros when there are no scans", async () => {
    /* Headline + 7 group queries + recent = 9 queries; each returns
       an empty rowset. */
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const a = await getAnalytics("code-1");
    expect(a.total_scans).toBe(0);
    expect(a.unique_visitors).toBe(0);
    expect(a.blocked_scans).toBe(0);
    expect(a.last_scanned_at).toBeNull();
    expect(a.by_day).toEqual([]);
    expect(a.by_country).toEqual([]);
    expect(a.recent).toEqual([]);
  });
  test("returns empty for empty codeId", async () => {
    const a = await getAnalytics("");
    expect(a.total_scans).toBe(0);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
  test("rolls up populated data", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            total_scans: 50,
            unique_visitors: 32,
            blocked_scans: 4,
            last_scanned_at: "2026-04-30T12:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ day: "2026-04-30", count: 50 }] })
      .mockResolvedValueOnce({ rows: [{ country: "US", count: 40 }, { country: null, count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ device: "mobile", count: 30 }] })
      .mockResolvedValueOnce({ rows: [{ browser: "Safari", count: 20 }] })
      .mockResolvedValueOnce({ rows: [{ os: "iOS", count: 20 }] })
      .mockResolvedValueOnce({ rows: [{ hour: 12, count: 15 }] })
      .mockResolvedValueOnce({ rows: [{ referrer: "https://t.co", count: 10 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            scanned_at: "2026-04-30T12:00:00Z",
            country: "US",
            device: "mobile",
            browser: "Safari",
            referrer: null,
          },
        ],
      });
    const a = await getAnalytics("code-1");
    expect(a.total_scans).toBe(50);
    expect(a.unique_visitors).toBe(32);
    expect(a.blocked_scans).toBe(4);
    expect(a.last_scanned_at).toBe("2026-04-30T12:00:00Z");
    expect(a.by_day).toEqual([{ day: "2026-04-30", count: 50 }]);
    /* Null-country row dropped. */
    expect(a.by_country).toEqual([{ country: "US", count: 40 }]);
    expect(a.by_device).toEqual([{ device: "mobile", count: 30 }]);
    expect(a.recent).toHaveLength(1);
  });
});
