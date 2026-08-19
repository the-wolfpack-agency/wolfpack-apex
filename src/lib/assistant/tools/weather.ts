/**
 * weather — empty-state demo tool. A brand-new user with zero
 * integrations connected can still ask "weather in Boston" and see
 * a populated WeatherWidget within a few hundred ms.
 *
 * Backed by Open-Meteo (no key required) — free public APIs only so
 * the demo path stays alive even on a fresh deploy.
 *
 *   geocode  → https://geocoding-api.open-meteo.com/v1/search?name=<q>
 *   forecast → https://api.open-meteo.com/v1/forecast?latitude=<la>&longitude=<lo>
 *              &current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code
 *              &daily=temperature_2m_max,temperature_2m_min
 *
 * Bare-prompt resolution (no city captured from "weather"):
 *   1. Use `ctx.geo.latitude` + `ctx.geo.longitude` if Vercel edge
 *      headers gave us coordinates. Skip the geocode round-trip and
 *      label the answer with `ctx.geo.city` (or "your location" when
 *      we have coords but no city name).
 *   2. Fall back to `ctx.geo.city` (geocode it) when only the city
 *      header was set but the lat/lng pair didn't parse.
 *   3. With no usable geo, return a friendly "tell me a city" message
 *      instead of guessing — the NYC-user-gets-Houston bug.
 *
 * Explicit cities ("weather in Boston") always go through the
 * Open-Meteo geocoder so the answer matches the user's intent
 * regardless of where they're connecting from.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolContext, ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * How somebody actually asks for the weather.
 *
 * Reported 2026-08-19: "what is the weather in NYC today?" did not reach this
 * tool. The pattern accepted "what's the weather" but not "what is the
 * weather", and nothing after the city, so the trailing "today" alone was
 * enough to miss. The question then fell through to a keyword branch further
 * up the pipeline and was answered with usage statistics.
 *
 * STILL ANCHORED, deliberately. This tool answers a whole question, not a
 * sentence that happens to mention weather: "the weather delayed the launch"
 * must not trigger a forecast. What is widened is the phrasing of the question
 * itself, not the freedom to appear anywhere in one.
 */
const INTENT_RE =
  /^\s*(?:(?:what|what'?s|how|how'?s)(?:\s+(?:is|are))?\s+(?:the\s+)?)?weather(?:\s+like)?(?:\s+(?:in|for|at)\s+(.+?))?(?:\s+(?:today|tonight|tomorrow|right\s+now|now|currently))?\s*\??\s*$/i;

const ParamSchema = z.object({
  /**
   * Captured city name when the user wrote "weather in <city>".
   * Empty string sentinel ("") = no city in the prompt; the handler
   * falls back to ctx.geo (IP lat/lng + city) for the requester's
   * actual location, or a friendly "tell me a city" message when no
   * geo is available. Zod's z.string() (no min) accepts the empty
   * string so this discriminator survives schema validation in the
   * dispatcher. */
  location: z.string().max(80),
});
type Params = z.infer<typeof ParamSchema>;

export interface WeatherToolData {
  location: string;
  temperature_c: number;
  temperature_f: number;
  condition: string;
  high_c: number;
  low_c: number;
  humidity: number;
  wind_mph: number;
}

interface CacheEntry {
  expires: number;
  data: WeatherToolData;
}
const cache = new Map<string, CacheEntry>();

/** Test seam — wipe the in-memory cache between tests so per-test
 *  fetch-call assertions aren't poisoned by prior fixtures. */
export function __resetWeatherCacheForTests(): void {
  cache.clear();
}

/* WMO weather-code → friendly condition string. Open-Meteo only
 * returns the numeric code; the renderer needs a label + emoji. */
function decodeWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rainy";
  if (code >= 71 && code <= 77) return "Snowy";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Unknown";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface GeocodeHit {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

async function geocode(location: string): Promise<GeocodeHit | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    location,
  )}&count=1&format=json`;
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: GeocodeHit[] };
  const hit = json.results?.[0];
  return hit ?? null;
}

interface ForecastResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

async function fetchForecast(
  lat: number,
  lon: number,
): Promise<ForecastResponse | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) return null;
  return (await res.json()) as ForecastResponse;
}

export const weatherTool: ToolDef<Params, WeatherToolData> = {
  name: "weather",
  description:
    "Current weather + today's high/low for a city. Empty-state demo tool — no integration required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent(message: string): Params | null {
    const m = INTENT_RE.exec(message);
    if (!m) return null;
    const captured = m[1]?.trim();
    /* Empty-string sentinel signals "no city in the prompt" to the
     * handler so it can defer to ctx.geo. We deliberately do NOT
     * fall back to a hard-coded city here — that's what caused the
     * NYC-user-gets-Houston bug. */
    return { location: captured && captured.length > 0 ? captured : "" };
  },
  async handler(params, ctx): Promise<ToolResult<WeatherToolData>> {
    /* Step 1: derive a stable cache key from the INPUT (prompt or geo)
     * before we hit any network. Lets a repeat call short-circuit
     * without invoking geocode → forecast a second time. */
    const cacheKey = deriveCacheKey(params.location, ctx);
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        const data = cached.data;
        trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
          location: data.location,
          success: true,
          cache_hit: true,
        });
        return buildSuccess(data);
      }
    }

    /* Step 2: resolve the {lat,lng,label} target. Three branches:
     *   1. Prompt captured a city → geocode it (existing behavior).
     *   2. Bare prompt + Vercel geo lat/lng → use directly, skip the
     *      Open-Meteo geocode round-trip.
     *   3. Bare prompt + only Vercel city header (no lat/lng) → fall
     *      back to geocoding the city string.
     *   4. No prompt city AND no geo → friendly "tell me a city".
     * The legacy hard-coded DEFAULT_LOCATION = "Houston" fallback is
     * deliberately gone. */
    const resolved = await resolveTarget(params.location, ctx);
    if (!resolved.ok) {
      trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
        location: params.location || "(empty)",
        success: false,
        reason: resolved.reason,
      });
      return resolved.result;
    }

    try {
      const forecast = await fetchForecast(resolved.latitude, resolved.longitude);
      if (!forecast || !forecast.current) {
        throw new Error("forecast empty");
      }
      const c = forecast.current;
      const d = forecast.daily;
      const tempC = Number(c.temperature_2m ?? 0);
      const data: WeatherToolData = {
        location: resolved.label,
        temperature_c: round1(tempC),
        temperature_f: round1(tempC * 9 / 5 + 32),
        condition: decodeWeatherCode(Number(c.weather_code ?? 0)),
        high_c: round1(Number(d?.temperature_2m_max?.[0] ?? tempC)),
        low_c: round1(Number(d?.temperature_2m_min?.[0] ?? tempC)),
        humidity: Math.round(Number(c.relative_humidity_2m ?? 0)),
        /* Open-Meteo returns wind in km/h by default; convert to mph. */
        wind_mph: round1(Number(c.wind_speed_10m ?? 0) * 0.621371),
      };

      /* Cache under both the input-derived key (so a repeat call with
       * the same prompt/geo short-circuits before network) AND the
       * resolved key (so two distinct inputs that resolve to the
       * same coords share a single entry). */
      if (cacheKey) cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, data });
      cache.set(resolved.cacheKey, { expires: Date.now() + CACHE_TTL_MS, data });

      trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
        location: data.location,
        success: true,
        cache_hit: false,
        source: resolved.source,
      });

      return buildSuccess(data);
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "network error";
      trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
        location: resolved.label,
        success: false,
        reason: "external_api_failed",
      });
      return {
        ok: false,
        code: "internal",
        message: `external_api_failed: ${message}`,
      };
    }
  },
};

/** Derive a stable cache key from the INPUT (prompt + ctx.geo) before
 *  resolving the target. Lets a repeat call with the same prompt or
 *  same geo headers short-circuit before geocode/forecast network
 *  calls fire. Returns null when nothing usable is in the input —
 *  the friendly "tell me a city" path is fast enough without caching
 *  and a null key documents that intentionally. */
function deriveCacheKey(promptLocation: string, ctx: ToolContext): string | null {
  const trimmed = promptLocation.trim();
  if (trimmed.length > 0) return `prompt:${trimmed.toLowerCase()}`;
  const geo = ctx.geo;
  if (
    geo &&
    typeof geo.latitude === "number" &&
    typeof geo.longitude === "number"
  ) {
    return `ll:${geo.latitude.toFixed(2)},${geo.longitude.toFixed(2)}`;
  }
  if (geo?.city) return `geo_city:${geo.city.toLowerCase()}`;
  return null;
}

/* ----------------------------------------------------------------------
 * Target resolution
 *
 * Returns a discriminated union so the handler can branch on `ok` and
 * either render the forecast (ok=true) or surface a deterministic
 * failure / friendly help message (ok=false). Three "ok" sources are
 * possible:
 *   - "prompt"   → user named the city explicitly
 *   - "geo_ll"   → Vercel edge headers gave us lat/lng directly
 *   - "geo_city" → Vercel gave us a city string; we geocoded it
 *
 * The "no usable input" branch returns ok=true at the ToolResult
 * level (not ok=false) so the chat surface renders the friendly help
 * message instead of an error toast.
 * ------------------------------------------------------------------ */

type ResolvedTarget =
  | {
      ok: true;
      latitude: number;
      longitude: number;
      label: string;
      cacheKey: string;
      source: "prompt" | "geo_ll" | "geo_city";
    }
  | {
      ok: false;
      reason: "geocode_no_match" | "no_city_no_geo";
      result: ToolResult<WeatherToolData>;
    };

async function resolveTarget(
  promptLocation: string,
  ctx: ToolContext,
): Promise<ResolvedTarget> {
  const trimmed = promptLocation.trim();
  /* Branch 1: explicit city in the prompt → geocode. */
  if (trimmed.length > 0) {
    const hit = await geocode(trimmed);
    if (!hit) {
      return {
        ok: false,
        reason: "geocode_no_match",
        result: {
          ok: false,
          code: "internal",
          message: `Couldn't find a place called "${trimmed}".`,
        },
      };
    }
    const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");
    return {
      ok: true,
      latitude: hit.latitude,
      longitude: hit.longitude,
      label,
      cacheKey: `prompt:${trimmed.toLowerCase()}`,
      source: "prompt",
    };
  }

  /* Branch 2: bare prompt + Vercel lat/lng → use them directly. */
  const geo = ctx.geo;
  if (
    geo &&
    typeof geo.latitude === "number" &&
    typeof geo.longitude === "number"
  ) {
    const label = geo.city
      ? [geo.city, geo.country].filter(Boolean).join(", ")
      : "your location";
    return {
      ok: true,
      latitude: geo.latitude,
      longitude: geo.longitude,
      label,
      /* Coordinate-keyed cache so two callers from the same edge node
       * share a single entry; round to 2 decimals (~1km) to keep the
       * cache effective without leaking precise locations into keys. */
      cacheKey: `ll:${geo.latitude.toFixed(2)},${geo.longitude.toFixed(2)}`,
      source: "geo_ll",
    };
  }

  /* Branch 3: bare prompt + only a city header → geocode it. */
  if (geo?.city) {
    const hit = await geocode(geo.city);
    if (!hit) {
      return {
        ok: false,
        reason: "geocode_no_match",
        result: {
          ok: false,
          code: "internal",
          message: `Couldn't find a place called "${geo.city}".`,
        },
      };
    }
    return {
      ok: true,
      latitude: hit.latitude,
      longitude: hit.longitude,
      label: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
      cacheKey: `geo_city:${geo.city.toLowerCase()}`,
      source: "geo_city",
    };
  }

  /* Branch 4: nothing usable → friendly help message. We return
   * ok=true (NOT a tool failure) so the chat surface renders the
   * help text as a normal answer rather than an error toast. */
  return {
    ok: false,
    reason: "no_city_no_geo",
    result: {
      ok: true,
      data: {
        location: "(unspecified)",
        temperature_c: 0,
        temperature_f: 0,
        condition: "Unknown",
        high_c: 0,
        low_c: 0,
        humidity: 0,
        wind_mph: 0,
      },
      answer:
        "Tell me a city — try `weather in Boston`.",
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function buildSuccess(data: WeatherToolData): ToolResult<WeatherToolData> {
  const widget: WidgetSpec = {
    kind: "weather",
    location: data.location,
    temperatureC: data.temperature_c,
    temperatureF: data.temperature_f,
    condition: data.condition,
    highC: data.high_c,
    lowC: data.low_c,
    humidity: data.humidity,
    windMph: data.wind_mph,
  };
  return {
    ok: true,
    data,
    answer: `${data.location}: ${data.temperature_f}°F (${data.condition}). High ${Math.round(data.high_c * 9 / 5 + 32)}°F / low ${Math.round(data.low_c * 9 / 5 + 32)}°F.`,
    widget,
  };
}

registerTool(weatherTool);
