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

/** Hard ceiling so a huge sitemap can't blow up a scan. */
const MAX_ROUTES = 100;

/** Discovery fetch timeout. */
const DISCOVER_TIMEOUT_MS = 8000;

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
    const decoded = raw
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");

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
 */
export async function discoverRoutes(
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<ScanRouteSpec[]> {
  const doFetch = fetchImpl ?? fetch;

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
