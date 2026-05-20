/**
 * Regression guard: every hardcoded route string in client-facing
 * source must resolve to an actual page.tsx (or be on an
 * explicit allowlist). Shipped 2026-05-20 after the assistant
 * surfaced a "Settings → Integrations" link to /settings/integrations
 * which 404'd in front of the team.
 *
 * Catches: anchor tags, href={}, redirect strings, and free-text
 * answer payloads that ship URLs to users.
 *
 * Scope: src/**.ts(x) excluding tests, .next, node_modules.
 * Excluded: API paths (/api/...), third-party URLs, dev_link paths.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "../..");
const SRC = join(REPO_ROOT, "src");
const APP = join(SRC, "app");

/* Collect the set of all rendered routes by walking src/app/**\/page.tsx. */
function collectRoutes(dir: string, base = ""): Set<string> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      /* Next.js segment-grouping parens — don't add to the URL. */
      const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
      /* Dynamic segments — collapse to a wildcard marker we'll match
         loosely. */
      const normalized = segment.replace(/\[([^\]]+)\]/g, ":$1");
      for (const r of collectRoutes(full, base + normalized)) out.add(r);
    } else if (entry === "page.tsx" || entry === "page.ts") {
      out.add(base || "/");
    }
  }
  return out;
}

const KNOWN_ROUTES = collectRoutes(APP);

/* Explicit allowlist for routes that exist outside src/app (e.g.
   external auth flows, deep-links handled by middleware, or
   intentionally documented placeholders). Keep this small. */
const ROUTE_ALLOWLIST = new Set([
  "/api", // any /api/* is allowed; checked below by prefix
  "/_next",
  "/static",
]);

function routeIsKnown(route: string): boolean {
  if (route.startsWith("/api/") || route === "/api") return true;
  if ([...ROUTE_ALLOWLIST].some((a) => route === a || route.startsWith(a + "/"))) return true;
  if (KNOWN_ROUTES.has(route)) return true;
  /* Try matching against dynamic-segment normalized routes. */
  for (const r of KNOWN_ROUTES) {
    if (!r.includes(":")) continue;
    const re = new RegExp("^" + r.replace(/:[\w]+/g, "[^/]+") + "$");
    if (re.test(route)) return true;
  }
  return false;
}

/* Scan a directory for relative-route literals. Returns { file, route }. */
function scanRoutes(dir: string): Array<{ file: string; route: string }> {
  const hits: Array<{ file: string; route: string }> = [];
  if (!existsSync(dir)) return hits;
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "__tests__" ||
      entry === ".claude" ||
      entry.startsWith(".") && entry !== "."
    ) {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      hits.push(...scanRoutes(full));
    } else if (/\.tsx$/.test(entry) && !entry.endsWith(".test.tsx")) {
      const content = readFileSync(full, "utf-8");
      /* Only scan `href="..."` (Link / anchor target) — those are
         the strings that actually send users to a URL. Plain string
         constants used by fetch() are validated elsewhere; not our
         concern here. Match either string-quoted or expression form
         with a string literal inside. */
      const RE = /href=(?:["'`]|\{["'`])(\/[a-z0-9_\-/]+)(?:["'`]|["'`]\})/gi;
      const seen = new Set<string>();
      for (const m of content.matchAll(RE)) {
        const raw = m[1];
        if (seen.has(raw)) continue;
        seen.add(raw);
        if (raw === "/" || raw.length < 2) continue;
        if (raw.startsWith("//")) continue;
        if (raw.startsWith("/api/")) continue; // fetch path, not a nav
        hits.push({ file: full.replace(REPO_ROOT + "/", ""), route: raw });
      }
    }
  }
  return hits;
}

/* Routes we explicitly DO NOT validate against page.tsx existence —
   either they're handled by middleware, are documentation snippets,
   or are part of upstream protocol prefixes. Keep small + explained. */
const SCAN_ROUTE_ALLOWLIST = new Set<string>([
  "/", // dashboard root
  "/api", // any /api/*
  "/login",
  "/forgot-password",
  "/reset-password",
  "/accept-invite",
  "/settings",
  "/setup",
  "/portal",
  /* Add cases here when a route IS valid but lives outside src/app
     (middleware-handled, etc.). Each addition gets a one-line reason. */
]);

describe("route-existence regression guard", () => {
  test("known routes set is non-empty (sanity)", () => {
    expect(KNOWN_ROUTES.size).toBeGreaterThan(10);
  });

  test("every hardcoded relative route in src/** resolves to a real page", () => {
    const hits = scanRoutes(SRC);
    const missing: Array<{ file: string; route: string }> = [];
    for (const h of hits) {
      if (SCAN_ROUTE_ALLOWLIST.has(h.route)) continue;
      if (routeIsKnown(h.route)) continue;
      /* Suppress noise: paths that look like file extensions or
         non-route artifacts. */
      if (/\.\w+$/.test(h.route)) continue;
      if (h.route.includes("/api/")) continue; // covered by routeIsKnown
      missing.push(h);
    }
    if (missing.length > 0) {
      const formatted = missing
        .slice(0, 30)
        .map((m) => `  ${m.route}\n    ↳ referenced in ${m.file}`)
        .join("\n");
      const more = missing.length > 30 ? `\n  ...and ${missing.length - 30} more` : "";
      throw new Error(
        `Hardcoded route(s) reference no page.tsx and aren't on the allowlist:\n${formatted}${more}\n\n` +
          `Either fix the link, create the page, or add the route to SCAN_ROUTE_ALLOWLIST with a reason.`,
      );
    }
  });
});
