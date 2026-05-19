/**
 * weather tool — intent matching, happy path, API failure, cache hit.
 *
 * Mocks the global `fetch` so the test never hits the live Open-Meteo
 * APIs. Each test runs in under a second.
 */

const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn(), query: jest.fn() }));

(global as unknown as { fetch: typeof fetch }).fetch =
  mockFetch as unknown as typeof fetch;

import { weatherTool, __resetWeatherCacheForTests } from "@/lib/assistant/tools/weather";

const match = (q: string) => weatherTool.matchIntent(q);
const CTX = { userId: "u1", userRole: "cto" };

function geocodeResp(name = "Boston", lat = 42.36, lon = -71.06) {
  return {
    ok: true,
    json: async () => ({
      results: [
        {
          name,
          latitude: lat,
          longitude: lon,
          admin1: "Massachusetts",
          country: "United States",
        },
      ],
    }),
  };
}

function forecastResp(opts: Partial<{
  temperature: number;
  weatherCode: number;
  humidity: number;
  wind: number;
  high: number;
  low: number;
}> = {}) {
  return {
    ok: true,
    json: async () => ({
      current: {
        temperature_2m: opts.temperature ?? 21.5,
        relative_humidity_2m: opts.humidity ?? 65,
        wind_speed_10m: opts.wind ?? 10,
        weather_code: opts.weatherCode ?? 2,
      },
      daily: {
        temperature_2m_max: [opts.high ?? 24],
        temperature_2m_min: [opts.low ?? 14],
      },
    }),
  };
}

beforeEach(() => {
  mockTrackEvent.mockReset();
  mockFetch.mockReset();
  /* Reset module-level cache between tests so cache-hit assertions
   * don't bleed across the test order. */
  __resetWeatherCacheForTests();
});

describe("weather intent matching", () => {
  test.each([
    "weather",
    "weather?",
    "weather in Boston",
    "weather in San Francisco",
    "what's the weather in NYC",
    "weather for Chicago",
    "weather at LAX",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test("default location used when none captured", () => {
    expect(match("weather")?.location).toBe("Houston");
  });

  test("captured location is preserved", () => {
    expect(match("weather in Boston")?.location).toBe("Boston");
  });

  test.each([
    "what's our revenue this quarter",
    "find emails from hoxsie",
    "create task to wash my car",
    /* Adjacent intents that must not get shadowed. */
    "fx rate",
    "top headlines",
    /* "weather report" is intentionally rejected — only the canonical
     * "weather" phrasings claim the tool. */
    "weather report yesterday",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("weather handler", () => {
  test("happy path: geocodes + fetches forecast + returns widget spec", async () => {
    mockFetch
      .mockResolvedValueOnce(geocodeResp("Boston"))
      .mockResolvedValueOnce(forecastResp({ temperature: 20, weatherCode: 0 }));

    const r = await weatherTool.handler({ location: "Boston" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("weather");
    const spec = r.widget as { kind: "weather"; location: string; condition: string };
    expect(spec.location).toMatch(/Boston/);
    expect(spec.condition).toBe("Clear");
    expect(r.answer).toMatch(/Boston/);
    expect(r.answer).toMatch(/°F/);
  });

  test("API failure on geocode → returns internal error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const r = await weatherTool.handler({ location: "ZZZNotARealCity" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("internal");
    expect(r.message).toMatch(/Couldn't find/);
  });

  test("network error on forecast → returns internal error", async () => {
    mockFetch
      .mockResolvedValueOnce(geocodeResp())
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await weatherTool.handler({ location: "Boston" }, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/external_api_failed/);
  });

  test("cache hit: second call with same location skips network", async () => {
    /* First call populates the cache. */
    mockFetch
      .mockResolvedValueOnce(geocodeResp("Tokyo", 35.68, 139.69))
      .mockResolvedValueOnce(forecastResp({ temperature: 25 }));
    const r1 = await weatherTool.handler({ location: "Tokyo" }, CTX);
    expect(r1.ok).toBe(true);
    const fetchCallsAfterFirst = mockFetch.mock.calls.length;

    /* Second call same location: must not invoke fetch. */
    const r2 = await weatherTool.handler({ location: "Tokyo" }, CTX);
    expect(r2.ok).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(fetchCallsAfterFirst);

    /* Cache-hit event payload signals the second hit. */
    const cacheHitEvents = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "assistant.weather_executed" && c[3]?.cache_hit === true,
    );
    expect(cacheHitEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("fires assistant.weather_executed on happy path", async () => {
    mockFetch
      .mockResolvedValueOnce(geocodeResp("Berlin", 52.52, 13.4))
      .mockResolvedValueOnce(forecastResp({ temperature: 18 }));
    await weatherTool.handler({ location: "Berlin" }, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.weather_executed",
      "u1",
      "cto",
      expect.objectContaining({ success: true }),
    );
  });
});
