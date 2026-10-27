/**
 * Forcefield Edge - which tenant a hostname belongs to, cached.
 *
 * The edge asks apex (GET /api/forcefield/edge/site?host=) once per hostname and
 * keeps the answer per instance:
 *   - a known hostname for POSITIVE_TTL_MS,
 *   - an unknown hostname for NEGATIVE_TTL_MS (a stray CNAME or a scanner sending
 *     random Host headers costs one lookup a minute, not one per request),
 *   - and, when apex cannot be reached, the last known record for up to
 *     STALE_IF_ERROR_MS, so an apex outage never takes a client's site down.
 * Concurrent lookups for one hostname share a single in-flight request, and the
 * cache is bounded (oldest entry evicted first).
 *
 * No secrets are logged. The service token travels only in the request header.
 */
import { coerceEdgeSite, type EdgeSite } from "./forcefield-web/gateway";

export const POSITIVE_TTL_MS = 60_000;
export const NEGATIVE_TTL_MS = 30_000;
export const STALE_IF_ERROR_MS = 60 * 60_000;
export const MAX_ENTRIES = 2_000;
const LOOKUP_TIMEOUT_MS = 3_000;

export interface SiteLookupConfig {
  /** Absolute apex endpoint, e.g. https://wolfpack-instinct.vercel.app/api/forcefield/edge/site */
  siteUrl: string;
  serviceToken: string;
  /** Local proof only: accept an http:// origin. Never set in production. */
  allowHttpOrigin?: boolean;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export type SiteLookup =
  | { ok: true; site: EdgeSite | null; source: "cache" | "live" | "stale" }
  | { ok: false; error: "unavailable" | "not_configured" };

interface Entry {
  site: EdgeSite | null;
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SiteLookup>>();

/** Test-only: clear the cache and in-flight map. */
export function _resetSiteCache(): void {
  cache.clear();
  inflight.clear();
}

function remember(host: string, site: EdgeSite | null, at: number): void {
  cache.delete(host);
  cache.set(host, { site, at });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function fetchLive(host: string, cfg: SiteLookupConfig, now: number): Promise<SiteLookup> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.siteUrl}?host=${encodeURIComponent(host)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      headers: { accept: "application/json", "x-edge-service-token": cfg.serviceToken },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.status === 404) {
      remember(host, null, now);
      return { ok: true, site: null, source: "live" };
    }
    if (res.ok) {
      const body = (await res.json()) as { site?: unknown };
      const site = coerceEdgeSite(body?.site, { allowHttp: cfg.allowHttpOrigin === true });
      // A 200 whose record does not validate is treated as unknown, never served.
      remember(host, site, now);
      return { ok: true, site, source: "live" };
    }
  } catch {
    /* fall through to stale-if-error */
  } finally {
    clearTimeout(timer);
  }
  const prev = cache.get(host);
  if (prev && prev.site && now - prev.at < STALE_IF_ERROR_MS) return { ok: true, site: prev.site, source: "stale" };
  return { ok: false, error: "unavailable" };
}

/** Resolve a (normalized) hostname to its Edge site record. Never throws. */
export async function lookupEdgeSite(host: string, cfg: SiteLookupConfig): Promise<SiteLookup> {
  if (!cfg.siteUrl || !cfg.serviceToken) return { ok: false, error: "not_configured" };
  const now = (cfg.nowMs ?? Date.now)();
  const hit = cache.get(host);
  if (hit) {
    const ttl = hit.site ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - hit.at < ttl) return { ok: true, site: hit.site, source: "cache" };
  }
  const pending = inflight.get(host);
  if (pending) return pending;
  const p = fetchLive(host, cfg, now).finally(() => inflight.delete(host));
  inflight.set(host, p);
  return p;
}
