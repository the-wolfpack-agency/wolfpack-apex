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
 * Default city (no location captured in the user's message): Houston —
 * Wolfpack Agency HQ. Picked once so analytics dashboards aren't
 * fragmented across geographies for unscoped queries.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

const DEFAULT_LOCATION = "Houston";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const INTENT_RE =
  /^\s*(?:what'?s\s+the\s+)?weather(?:\s+(?:in|for|at)\s+(.+?))?\??\s*$/i;

const ParamSchema = z.object({
  location: z.string().min(1).max(80),
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
    return { location: captured && captured.length > 0 ? captured : DEFAULT_LOCATION };
  },
  async handler(params, ctx): Promise<ToolResult<WeatherToolData>> {
    const key = params.location.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      const data = cached.data;
      trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
        location: data.location,
        success: true,
        cache_hit: true,
      });
      return buildSuccess(data);
    }

    try {
      const hit = await geocode(params.location);
      if (!hit) {
        trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
          location: params.location,
          success: false,
          reason: "geocode_no_match",
        });
        return {
          ok: false,
          code: "internal",
          message: `Couldn't find a place called "${params.location}".`,
        };
      }
      const forecast = await fetchForecast(hit.latitude, hit.longitude);
      if (!forecast || !forecast.current) {
        throw new Error("forecast empty");
      }
      const c = forecast.current;
      const d = forecast.daily;
      const tempC = Number(c.temperature_2m ?? 0);
      const data: WeatherToolData = {
        location: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
        temperature_c: round1(tempC),
        temperature_f: round1(tempC * 9 / 5 + 32),
        condition: decodeWeatherCode(Number(c.weather_code ?? 0)),
        high_c: round1(Number(d?.temperature_2m_max?.[0] ?? tempC)),
        low_c: round1(Number(d?.temperature_2m_min?.[0] ?? tempC)),
        humidity: Math.round(Number(c.relative_humidity_2m ?? 0)),
        /* Open-Meteo returns wind in km/h by default; convert to mph. */
        wind_mph: round1(Number(c.wind_speed_10m ?? 0) * 0.621371),
      };

      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });

      trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
        location: data.location,
        success: true,
        cache_hit: false,
      });

      return buildSuccess(data);
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "network error";
      trackEvent("assistant.weather_executed", ctx.userId, ctx.userRole, {
        location: params.location,
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
