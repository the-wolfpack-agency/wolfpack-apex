/**
 * vercel-geo — read VercelGeo off the request `Headers` so tools can
 * use the requester's actual location instead of a hard-coded default.
 *
 * Vercel injects these headers automatically on every request to a
 * deployment (no project config required):
 *
 *   x-vercel-ip-city        — URL-encoded city name ("New%20York")
 *   x-vercel-ip-country     — ISO 3166-1 alpha-2 ("US")
 *   x-vercel-ip-latitude    — decimal degrees as string
 *   x-vercel-ip-longitude   — decimal degrees as string
 *
 * Routes that hand a `ToolContext` to the dispatcher should call
 * `readVercelGeo(req.headers)` and pass the returned object as
 * `ctx.geo`. Tools (currently: weather) consult it when the user's
 * prompt didn't capture a specific city. On local dev / non-Vercel
 * deployments the headers are absent and this helper returns an empty
 * object; tools must treat geo as best-effort and degrade gracefully.
 */

import type { VercelGeo } from "@/lib/assistant/tools/types";

/** Parse a header that should be a finite decimal-degree latitude. */
function parseLat(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -90 || n > 90) return undefined;
  return n;
}

/** Parse a header that should be a finite decimal-degree longitude. */
function parseLon(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -180 || n > 180) return undefined;
  return n;
}

/** Vercel encodes city names so non-ASCII / spaces survive HTTP transit
 *  ("New%20York"). decodeURIComponent reverses that; we guard against
 *  malformed values so a bad header never crashes the request. */
function decodeCity(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 && decoded.length <= 80 ? decoded : undefined;
  } catch {
    /* decodeURIComponent throws on invalid percent-escapes — bail. */
    return undefined;
  }
}

/** Lift `VercelGeo` off the request headers. Returns an empty object
 *  when no geo signal is present so callers can pass the result
 *  unconditionally without null-checking. */
export function readVercelGeo(headers: Headers): VercelGeo {
  const geo: VercelGeo = {};
  const city = decodeCity(headers.get("x-vercel-ip-city"));
  if (city) geo.city = city;
  const country = headers.get("x-vercel-ip-country");
  if (country && country.length === 2) geo.country = country.toUpperCase();
  const lat = parseLat(headers.get("x-vercel-ip-latitude"));
  const lon = parseLon(headers.get("x-vercel-ip-longitude"));
  /* Latitude and longitude travel as a pair — never one without the
   *  other, otherwise tools that need both end up with bogus midpoints. */
  if (lat !== undefined && lon !== undefined) {
    geo.latitude = lat;
    geo.longitude = lon;
  }
  return geo;
}
