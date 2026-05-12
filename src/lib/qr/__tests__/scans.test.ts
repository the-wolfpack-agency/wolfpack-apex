 
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
  isBotUa,
  extractLanguage,
  extractUtm,
  extractClientHints,
  extractEdgeGeo,
  matchClient,
  listScans,
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

describe("isBotUa", () => {
  test("flags crawler UAs", () => {
    expect(isBotUa("Mozilla/5.0 (compatible; Googlebot/2.1; ...)")).toBe(true);
    expect(isBotUa("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
    expect(isBotUa("YandexBot/3.0")).toBe(true);
  });
  test("flags link-unfurl preview fetchers", () => {
    expect(isBotUa("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isBotUa("facebookexternalhit/1.1; preview-bot")).toBe(true);
  });
  test("does not flag normal browsers", () => {
    expect(isBotUa("Mozilla/5.0 (Macintosh) Chrome/120 Safari/537")).toBe(false);
    expect(isBotUa("Mozilla/5.0 (iPhone) Safari/604.1")).toBe(false);
  });
  test("null/empty UA = not bot", () => {
    expect(isBotUa(null)).toBe(false);
    expect(isBotUa("")).toBe(false);
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

describe("extractLanguage", () => {
  test("returns first tag from Accept-Language", () => {
    const h = new Headers({ "accept-language": "en-US,en;q=0.9,fr;q=0.8" });
    expect(extractLanguage(h)).toBe("en-US");
  });
  test("returns null when header is missing", () => {
    expect(extractLanguage(new Headers())).toBeNull();
  });
  test("rejects malformed values", () => {
    const h = new Headers({ "accept-language": "  ; ;" });
    expect(extractLanguage(h)).toBeNull();
  });
  test("rejects entries with control chars", () => {
    const h = new Headers({ "accept-language": "en US" });
    expect(extractLanguage(h)).toBeNull();
  });
});

describe("extractUtm", () => {
  test("parses utm fields off URL", () => {
    const out = extractUtm(
      "https://wp.test/q/abc?utm_source=qr&utm_medium=offline&utm_campaign=spring",
    );
    expect(out).toEqual({
      source: "qr",
      medium: "offline",
      campaign: "spring",
    });
  });
  test("returns nulls when URL has no UTMs", () => {
    expect(extractUtm("https://wp.test/q/abc")).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
  });
  test("returns nulls for invalid URL", () => {
    expect(extractUtm("not a url")).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
  });
  test("returns nulls when URL is undefined", () => {
    expect(extractUtm(undefined)).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
  });
});

describe("extractClientHints", () => {
  test("parses tz and screen size", () => {
    const out = extractClientHints("https://wp.test/q/abc?tz=-300&s=390x844");
    expect(out).toEqual({ tzOffsetMinutes: -300, screenSize: "390x844" });
  });
  test("rejects out-of-range tz", () => {
    expect(
      extractClientHints("https://wp.test/q/abc?tz=9999"),
    ).toEqual({ tzOffsetMinutes: null, screenSize: null });
  });
  test("rejects malformed screen size", () => {
    expect(
      extractClientHints("https://wp.test/q/abc?s=abc"),
    ).toEqual({ tzOffsetMinutes: null, screenSize: null });
  });
});

describe("extractEdgeGeo", () => {
  test("returns lat/lng/postal when all valid", () => {
    const h = new Headers({
      "x-vercel-ip-latitude": "40.7128",
      "x-vercel-ip-longitude": "-74.0060",
      "x-vercel-ip-postal-code": "10001",
    });
    expect(extractEdgeGeo(h)).toEqual({
      latitude: "40.7128",
      longitude: "-74.0060",
      postalCode: "10001",
    });
  });
  test("returns null lat/lng when only one supplied (coupled)", () => {
    const h = new Headers({ "x-vercel-ip-latitude": "40.7128" });
    expect(extractEdgeGeo(h).latitude).toBeNull();
    expect(extractEdgeGeo(h).longitude).toBeNull();
  });
  test("rejects out-of-range coords", () => {
    const h = new Headers({
      "x-vercel-ip-latitude": "999",
      "x-vercel-ip-longitude": "0",
    });
    expect(extractEdgeGeo(h).latitude).toBeNull();
  });
});

describe("matchClient", () => {
  test("returns null when there are no signals", async () => {
    const out = await matchClient({});
    expect(out).toEqual({ clientId: null, score: 0 });
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("matches on referrer host == contact_email domain (+0.5)", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "client-1",
          name: "Acme",
          contact_email: "ops@acme.com",
          docs: null,
        },
        {
          id: "client-2",
          name: "Beta",
          contact_email: "hi@beta.io",
          docs: null,
        },
      ],
    });
    const out = await matchClient({
      referrer: "https://acme.com/landing",
    });
    expect(out.clientId).toBe("client-1");
    expect(out.score).toBeGreaterThanOrEqual(0.5);
  });

  test("city + state from docs jsonb stack into a strong match", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "client-1",
          name: "Acme",
          contact_email: null,
          docs: { address_city: "San Francisco", address_state: "CA" },
        },
      ],
    });
    const out = await matchClient({ city: "san francisco", region: "ca" });
    expect(out.clientId).toBe("client-1");
    /* 0.5 (city) + 0.2 (state) = 0.7 */
    expect(out.score).toBeCloseTo(0.7, 2);
  });

  test("weak match (< 0.5) is dropped", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "client-1",
          name: "Acme",
          contact_email: null,
          docs: { address_state: "CA" }, // 0.2 alone
        },
      ],
    });
    const out = await matchClient({ region: "CA" });
    expect(out.clientId).toBeNull();
    expect(out.score).toBe(0);
  });

  test("no rows or query failure is graceful", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const out = await matchClient({ referrer: "https://x.test" });
    expect(out).toEqual({ clientId: null, score: 0 });
  });
});

describe("recordScan", () => {
  test("inserts hashed visitor + parsed UA + extended attribution", async () => {
    /* matchClient consults instinct_clients first — return empty so
       it short-circuits to no match. */
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const headers = new Headers({
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Safari/604.1",
      "x-forwarded-for": "203.0.113.7",
      referer: "https://twitter.com/share",
      "accept-language": "en-US,en;q=0.9",
      "x-vercel-ip-latitude": "40.7128",
      "x-vercel-ip-longitude": "-74.0060",
      "x-vercel-ip-postal-code": "10001",
    });
    await recordScan({
      codeId: "code-1",
      headers,
      requestUrl:
        "https://wp.test/q/abc?utm_source=linkedin&utm_medium=social&utm_campaign=launch&tz=-300&s=390x844",
    });
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params[0]).toBe("code-1");
    expect(params[1]).toHaveLength(16); // visitor hash
    expect(params[5]).toBe("mobile"); // device
    expect(params[6]).toBe("iOS"); // os
    expect(params[8]).toBe("https://twitter.com/share"); // referrer
    expect(params[9]).toBe(false); // blocked default
    /* Extended columns: 10..21 */
    expect(params[10]).toBe("en-US"); // language
    expect(params[11]).toBe(-300); // tz offset
    expect(params[12]).toBe("390x844"); // screen size
    expect(params[13]).toBe(false); // is_bot
    expect(params[14]).toBe("linkedin"); // utm_source
    expect(params[15]).toBe("social"); // utm_medium
    expect(params[16]).toBe("launch"); // utm_campaign
    expect(params[17]).toBe("40.7128"); // latitude
    expect(params[18]).toBe("-74.0060"); // longitude
    expect(params[19]).toBe("10001"); // postal
    expect(params[20]).toBeNull(); // client_id (no clients in mock)
    expect(params[21]).toBeNull(); // client_match_score
  });

  test("flags is_bot=true for crawler UAs", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await recordScan({
      codeId: "code-1",
      headers: new Headers({
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
      }),
      requestUrl: "https://wp.test/q/abc",
    });
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params[13]).toBe(true);
  });

  test("respects blocked=true and geo overrides", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
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

  test("populates client_id when match heuristic finds one", async () => {
    /* First safeQuery: matchClient lookup returns a strong match. */
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "client-acme",
          name: "Acme",
          contact_email: "ops@acme.com",
          docs: null,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await recordScan({
      codeId: "code-1",
      headers: new Headers({
        referer: "https://acme.com/landing",
      }),
      requestUrl: "https://wp.test/q/abc",
    });
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params[20]).toBe("client-acme");
    expect(params[21]).toBeGreaterThan(0);
  });

  test("missing codeId is a no-op", async () => {
    await recordScan({ codeId: "", headers: new Headers() });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  test("DB error swallowed (best-effort)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(
      recordScan({ codeId: "code-1", headers: new Headers() }),
    ).resolves.toBeUndefined();
  });

  test("matchClient failure does not block the write", async () => {
    /* matchClient throws — recordScan must still insert with null
       client_id and not propagate the error. */
    mockSafeQuery.mockRejectedValueOnce(new Error("client lookup failed"));
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      recordScan({ codeId: "code-1", headers: new Headers() }),
    ).resolves.toBeUndefined();
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockWriteQuery.mock.calls[0];
    expect(params[20]).toBeNull();
  });
});

describe("listScans", () => {
  test("returns full row shape", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "scan-1",
          scanned_at: "2026-04-30T12:00:00Z",
          visitor_hash: "abc123def456ab12",
          country: "US",
          region: "CA",
          city: "San Francisco",
          postal_code: "94110",
          latitude: "37.7",
          longitude: "-122.4",
          device: "mobile",
          os: "iOS",
          browser: "Safari",
          language: "en-US",
          timezone_offset_minutes: -480,
          screen_size: "390x844",
          is_bot: false,
          referrer: "https://t.co/x",
          utm_source: "linkedin",
          utm_medium: "social",
          utm_campaign: "spring",
          blocked: false,
          client_id: "client-1",
          client_match_score: "0.7",
          client_name: "Acme",
        },
      ],
    });
    const out = await listScans("code-1");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("scan-1");
    expect(out[0].client_match_score).toBeCloseTo(0.7);
    expect(out[0].client_name).toBe("Acme");
    expect(out[0].is_bot).toBe(false);
  });

  test("returns [] for empty codeId", async () => {
    expect(await listScans("")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("caps limit at 500", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listScans("code-1", 10000);
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params[1]).toBe(500);
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
