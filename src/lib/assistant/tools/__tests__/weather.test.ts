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

  test("bare prompt yields empty-string location sentinel (handler defers to ctx.geo)", () => {
    /* Locks the 2026-05-19 fix for the NYC-user-gets-Houston bug. The
     * legacy DEFAULT_LOCATION = "Houston" branch was removed; the
     * intent classifier now signals "no city captured" with an empty
     * string and the handler resolves the target from ctx.geo. */
    expect(match("weather")?.location).toBe("");
    expect(match("weather?")?.location).toBe("");
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

/* ----------------------------------------------------------------------
 * 2026-05-19 — bare-prompt + Vercel IP-geo plumbing
 *
 * Locks the fix for the NYC-user-types-"weather"-gets-Houston bug.
 * The handler must:
 *   - Use ctx.geo.latitude / longitude directly when present (skip the
 *     geocode round-trip; only the forecast call hits the network).
 *   - Geocode ctx.geo.city when only the city header is set.
 *   - Return a friendly "tell me a city" answer (ok=true so it renders
 *     as a normal message, not an error toast) when neither the prompt
 *     nor ctx.geo gives us anything usable.
 * -------------------------------------------------------------------- */
describe("weather handler — IP geo fallback", () => {
  test("bare prompt + geo lat/lng → uses coords directly, skips geocode", async () => {
    /* Only ONE fetch — the forecast call. The geocode round-trip is
     * skipped because Vercel handed us coordinates. */
    mockFetch.mockResolvedValueOnce(forecastResp({ temperature: 12 }));
    const r = await weatherTool.handler(
      { location: "" },
      {
        ...CTX,
        geo: { city: "New York", country: "US", latitude: 40.7128, longitude: -74.006 },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toMatch(/api\.open-meteo\.com\/v1\/forecast/);
    expect(mockFetch.mock.calls[0][0]).toMatch(/latitude=40\.7128/);
    expect(mockFetch.mock.calls[0][0]).toMatch(/longitude=-74\.006/);
    expect(r.answer).toMatch(/New York/);
    /* Telemetry distinguishes the resolution path so the learning loop
     * sees when geo headers are landing. */
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.weather_executed",
      "u1",
      "cto",
      expect.objectContaining({ source: "geo_ll", success: true }),
    );
  });

  test("bare prompt + geo lat/lng but no city → labels as 'your location'", async () => {
    mockFetch.mockResolvedValueOnce(forecastResp({ temperature: 5 }));
    const r = await weatherTool.handler(
      { location: "" },
      { ...CTX, geo: { latitude: 51.5074, longitude: -0.1278 } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/your location/);
  });

  test("bare prompt + geo city only (no lat/lng) → geocodes the city", async () => {
    mockFetch
      .mockResolvedValueOnce(geocodeResp("Brooklyn", 40.65, -73.95))
      .mockResolvedValueOnce(forecastResp({ temperature: 15 }));
    const r = await weatherTool.handler(
      { location: "" },
      { ...CTX, geo: { city: "Brooklyn", country: "US" } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toMatch(/geocoding-api\.open-meteo\.com/);
    expect(mockFetch.mock.calls[0][0]).toMatch(/name=Brooklyn/);
    expect(r.answer).toMatch(/Brooklyn/);
  });

  test("bare prompt + NO geo → friendly 'tell me a city' answer (no network)", async () => {
    const r = await weatherTool.handler({ location: "" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* Zero fetches: we never burn an API call on a guess. */
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.answer).toMatch(/Tell me a city/i);
    expect(r.answer).toMatch(/weather in Boston/);
    /* Friendly path is NOT a tool failure — no widget either. */
    expect(r.widget).toBeUndefined();
  });

  test("bare prompt + empty geo object → same friendly fallback", async () => {
    const r = await weatherTool.handler({ location: "" }, { ...CTX, geo: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.answer).toMatch(/Tell me a city/i);
  });

  test("explicit 'weather in Boston' ignores geo and geocodes the city", async () => {
    /* User asked for Boston while the edge headers say London. Boston
     * wins — the prompt always trumps geo for explicit queries. */
    mockFetch
      .mockResolvedValueOnce(geocodeResp("Boston", 42.36, -71.06))
      .mockResolvedValueOnce(forecastResp({ temperature: 10 }));
    const r = await weatherTool.handler(
      { location: "Boston" },
      {
        ...CTX,
        geo: { city: "London", country: "GB", latitude: 51.5074, longitude: -0.1278 },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toMatch(/geocoding-api\.open-meteo\.com/);
    expect(mockFetch.mock.calls[0][0]).toMatch(/name=Boston/);
    expect(r.answer).toMatch(/Boston/);
    expect(r.answer).not.toMatch(/London/);
  });
});
