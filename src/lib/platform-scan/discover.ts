/**
 * Manifest auto-discovery for platform-scan.
 *
 * Derives a target's route list from its `sitemap.xml` so a scan covers the
 * real surface instead of only the curated seed in `manifests.ts`. The seed
 * stays authoritative (its hand-tuned auth/journey labels win on conflict); the
 * discovered routes extend it with whatever else the target publishes.
 *
 * Auth inference mirrors the seed manifest's contract for wolfpack-auto:
 * `/admin*` is auth-gated EXCEPT `/admin/login` (the sign-in page is public),
 * and everything else is public. journey is a readable label from the last path
 * segment so a finding is human-scannable without re-deriving the URL.
 *
 * All three functions degrade gracefully: parse failures, non-http locs, and
 * fetch/network errors never throw — they yield `[]` so a missing or malformed
 * sitemap simply falls back to the seed manifest.
 */

import type { ScanRouteSpec } from "./types";
import type { PolitenessOptions } from "./types";
import { PoliteFetcher } from "./http/polite-fetch";

/** Hard ceiling so a huge sitemap can't blow up a scan. */
const MAX_ROUTES = 100;

/** Discovery fetch timeout. */
const DISCOVER_TIMEOUT_MS = 8000;

/** The XML entities that legally appear in a sitemap <loc>. */
const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Title-case a path segment ("admin-leads" / "admin_leads" → "Admin Leads"). */
function labelFromSegment(segment: string): string {
  const cleaned = segment
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Derive a readable journey label from a route path. */
function journeyFromPath(path: string): string {
  // Strip query before deriving the label, then take the last non-empty segment.
  const pathname = path.split("?")[0] ?? path;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "Home";
  const last = segments[segments.length - 1];
  const label = labelFromSegment(last);
  return label || "Home";
}

/** Auth contract: /admin* is required, except /admin/login; everything else public. */
function authFromPath(path: string): ScanRouteSpec["auth"] {
  const pathname = (path.split("?")[0] ?? path).toLowerCase();
  if (pathname === "/admin/login") return "public";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "required";
  return "public";
}

/**
 * PURE. Parse a sitemap XML body into route specs.
 *
 * Extracts every `<loc>` URL, strips the baseUrl origin to a path (keeping path
 * + query, dropping the origin), de-dupes by path, infers auth + journey, and
 * caps the result at MAX_ROUTES. Non-http locs and malformed entries are skipped.
 */
export function parseSitemap(xml: string, baseUrl: string): ScanRouteSpec[] {
  if (!xml || typeof xml !== "string") return [];

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const specs: ScanRouteSpec[] = [];
  const seen = new Set<string>();

  const locRegex = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(xml)) !== null) {
    if (specs.length >= MAX_ROUTES) break;

    const raw = match[1]?.trim();
    if (!raw) continue;

    // Decode the handful of XML entities that legally appear in a <loc>.
    // Single pass: chained .replace() calls would decode the output of an
    // earlier one, so "&amp;lt;" would collapse to "<" instead of "&lt;"
    // (CodeQL: js/double-escaping). One pass can never re-consume its output.
    const decoded = raw.replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_m, entity: string) => XML_ENTITIES[entity] ?? _m,
    );

    let url: URL;
    try {
      url = new URL(decoded);
    } catch {
      continue; // malformed / relative loc
    }

    // Only http(s) locs are scannable surfaces.
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    // Keep path + query, drop the origin. (We tolerate cross-origin locs by
    // taking their path; the scanner probes against baseUrl regardless.)
    const path = `${url.pathname}${url.search}`;
    if (!path.startsWith("/")) continue;

    if (seen.has(path)) continue;
    seen.add(path);

    specs.push({
      path,
      journey: journeyFromPath(path),
      auth: authFromPath(path),
    });
  }

  // origin is referenced to make the "strip origin" intent explicit; the path
  // extraction above is origin-agnostic by design, so nothing further to do.
  void origin;

  return specs;
}

/**
 * Fetch `${baseUrl}/sitemap.xml` and parse it into route specs.
 *
 * Never throws: non-200, network error, timeout, or empty body all yield `[]`
 * so the caller falls back to the seed manifest. Uses an 8s AbortController
 * timeout. `fetchImpl` is injectable for tests; defaults to global `fetch`.
 *
 * POLITENESS: the sitemap fetch is a request to the CLIENT'S host, so it goes
 * through the same shared per-host politeness layer as the route probes (see
 * ./http/polite-fetch.ts). For a single discovery request the concurrency cap is
 * moot, but the 429/503 Retry-After backoff matters - if a client's host is
 * already throttling, discovery must back off too, not hammer it. `politeness`
 * is optional; its onThrottle hook lets the caller emit platform.scan_throttled.
 */
export async function discoverRoutes(
  baseUrl: string,
  fetchImpl?: typeof fetch,
  politeness?: PolitenessOptions,
): Promise<ScanRouteSpec[]> {
  const p = politeness ?? {};
  const fetcher = new PoliteFetcher({
    fetchImpl: fetchImpl ?? fetch,
    perHostConcurrency: p.perHostConcurrency,
    minGapMs: p.minGapMs,
    maxRetries: p.maxRetries,
    baseBackoffMs: p.baseBackoffMs,
    maxBackoffMs: p.maxBackoffMs,
    now: p.now,
    sleep: p.sleep,
    onThrottle: p.onThrottle,
  });
  const doFetch = (url: string, init: RequestInit) => fetcher.fetch(url, init);

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);

  try {
    const res = await doFetch(`${origin}/sitemap.xml`, {
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) return [];

    const text = await res.text();
    if (!text || !text.trim()) return [];

    return parseSitemap(text, baseUrl);
  } catch {
    return []; // network error, abort/timeout, parse-of-body failure
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Union a curated seed manifest with discovered routes, de-duped by `path`.
 *
 * Seed entries are authoritative: on a path conflict the seed's curated
 * auth/journey wins. Seed order is preserved first, then newly discovered
 * routes (not already present in the seed) in discovery order.
 */
export function mergeManifest(
  seed: ScanRouteSpec[],
  discovered: ScanRouteSpec[],
): ScanRouteSpec[] {
  const seenPaths = new Set<string>();
  const merged: ScanRouteSpec[] = [];

  for (const spec of seed) {
    if (seenPaths.has(spec.path)) continue;
    seenPaths.add(spec.path);
    merged.push(spec);
  }

  for (const spec of discovered) {
    if (seenPaths.has(spec.path)) continue; // seed wins
    seenPaths.add(spec.path);
    merged.push(spec);
  }

  return merged;
}

/** Breadth ceiling for a crawl (pages visited). Capped by MAX_ROUTES too. */
const MAX_CRAWL_PAGES = 60;
/** How many link-hops deep to follow from the base. */
const DEFAULT_CRAWL_DEPTH = 3;

/**
 * PURE. Extract same-origin link paths from an HTML page.
 *
 * Finds `<a href>` targets, resolves each against `pageUrl`, keeps only those on
 * `origin` (a crawl never wanders to a third-party host, so there is no SSRF
 * surface), drops the fragment, and returns unique `path + search` strings.
 * mailto:, tel:, javascript: and bare "#" anchors are ignored.
 */
export function extractLinks(html: string, pageUrl: string, origin: string): string[] {
  if (!html || typeof html !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || /^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue; // same-origin only (no SSRF)
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const path = `${url.pathname}${url.search}`;
    if (!path.startsWith("/") || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export interface CrawlOptions {
  fetchImpl?: typeof fetch;
  politeness?: PolitenessOptions;
  /** Max pages to visit. Capped at MAX_ROUTES regardless. */
  maxPages?: number;
  /** Max link-hops from the base. */
  maxDepth?: number;
  /** Extra request headers, e.g. a session Cookie for an authenticated crawl. */
  headers?: Record<string, string>;
}

/**
 * Link-following, same-origin, bounded, polite crawl starting at `baseUrl`.
 * Discovers the reachable route graph a sitemap may omit, especially the
 * AUTHENTICATED surface when `headers` carries a session cookie, which is the
 * whole point of "map the full system" for an assessment.
 *
 * Safe by construction: only same-origin links are followed (no SSRF to other
 * hosts), breadth + depth are capped, each fetch has an 8s timeout and goes
 * through the shared politeness layer (429/503 back-off), and any error yields
 * whatever was discovered so far, it never throws. The base URL is
 * ownership-verified by the caller before a crawl runs.
 */
export async function crawlRoutes(baseUrl: string, opts: CrawlOptions = {}): Promise<ScanRouteSpec[]> {
  let origin: string;
  let startPath: string;
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    const path = `${u.pathname}${u.search}`;
    startPath = path.startsWith("/") ? path : "/";
  } catch {
    return [];
  }

  const maxPages = Math.min(opts.maxPages ?? MAX_CRAWL_PAGES, MAX_ROUTES);
  const maxDepth = opts.maxDepth ?? DEFAULT_CRAWL_DEPTH;

  const p = opts.politeness ?? {};
  const fetcher = new PoliteFetcher({
    fetchImpl: opts.fetchImpl ?? fetch,
    perHostConcurrency: p.perHostConcurrency,
    minGapMs: p.minGapMs,
    maxRetries: p.maxRetries,
    baseBackoffMs: p.baseBackoffMs,
    maxBackoffMs: p.maxBackoffMs,
    now: p.now,
    sleep: p.sleep,
    onThrottle: p.onThrottle,
  });

  const seen = new Set<string>([startPath]);
  const frontier: { path: string; depth: number }[] = [{ path: startPath, depth: 0 }];
  const routes: ScanRouteSpec[] = [];

  while (frontier.length > 0 && routes.length < maxPages) {
    const { path, depth } = frontier.shift()!;
    routes.push({ path, journey: journeyFromPath(path), auth: authFromPath(path) });
    if (depth >= maxDepth) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
    let html = "";
    try {
      const res = await fetcher.fetch(`${origin}${path}`, {
        signal: controller.signal,
        redirect: "follow",
        headers: opts.headers,
      });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
        html = await res.text();
      }
    } catch {
      html = ""; // network/timeout: record the route, follow no links
    } finally {
      clearTimeout(timer);
    }

    if (!html) continue;
    for (const link of extractLinks(html, `${origin}${path}`, origin)) {
      if (seen.has(link) || seen.size >= MAX_ROUTES) continue;
      seen.add(link);
      frontier.push({ path: link, depth: depth + 1 });
    }
  }

  return routes;
}
