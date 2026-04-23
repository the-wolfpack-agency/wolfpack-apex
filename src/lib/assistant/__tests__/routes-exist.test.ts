/**
 * Scanner-style invariant: every route surfaced by the assistant MUST
 * correspond to a real Next.js page that would render a 200, not a 404.
 *
 * We landed `/dashboard` in PAGE_FACTS when the actual dashboard route
 * is `/` (the index under the `(dashboard)` route group). A user who
 * clicked the Dashboard link from an assistant answer hit a 404 on
 * production. The test below enumerates every route the assistant can
 * hand a user — from PAGE_FACTS and from the related-pages DOMAIN_MAP
 * — and resolves each one against `src/app/` to verify the route
 * actually exists.
 *
 * Per global invariant: codify checks as tooling, not AI review.
 */

import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { PAGE_FACTS } from "../page-facts";
import { getDomainRoutes } from "../related-pages";

const SRC_APP = resolve(__dirname, "../../../app");

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map an Instinct route like "/calendar" or "/admin/audit" or "/" to
 * the candidate Next.js page.tsx file paths that would render it.
 *
 * Next.js App Router supports route groups like `(dashboard)`, which
 * don't appear in the URL. The dashboard in this repo lives under
 * `src/app/(dashboard)/...`. Root `/` resolves to
 * `src/app/(dashboard)/page.tsx` or `src/app/page.tsx`.
 */
function resolveCandidates(route: string): string[] {
  // Strip trailing slash, drop leading slash, split on `/`.
  const clean = route.replace(/\/$/, "");
  const parts = clean.split("/").filter(Boolean);
  const candidates: string[] = [];
  const groups = ["", "(dashboard)"];
  for (const group of groups) {
    const baseSegments = group ? [group, ...parts] : [...parts];
    candidates.push(join(SRC_APP, ...baseSegments, "page.tsx"));
    candidates.push(join(SRC_APP, ...baseSegments, "page.ts"));
  }
  return candidates;
}

function routeResolves(route: string): boolean {
  return resolveCandidates(route).some(exists);
}

describe("assistant-surfaced routes all render a real page", () => {
  it.each(
    Object.values(PAGE_FACTS).map((f) => [f.domain, f.route] as [string, string]),
  )("PAGE_FACTS[%s] route %s resolves to a Next.js page", (_domain, route) => {
    const candidates = resolveCandidates(route);
    const resolved = candidates.some(exists);
    if (!resolved) {
      throw new Error(
        `PAGE_FACTS route "${route}" does not resolve to a page.tsx.\n` +
          `Tried:\n  ${candidates.join("\n  ")}`,
      );
    }
    expect(resolved).toBe(true);
  });

  it.each(
    Object.entries(getDomainRoutes()).map(
      ([domain, { href }]) => [domain, href] as [string, string],
    ),
  )("related-pages DOMAIN_MAP[%s] href %s resolves to a Next.js page", (_domain, href) => {
    const resolved = routeResolves(href);
    expect(resolved).toBe(true);
  });

  it("dashboard specifically points at the root route, not /dashboard", () => {
    // Regression: we had /dashboard which 404'd in prod because the
    // actual dashboard page is at src/app/(dashboard)/page.tsx → "/".
    expect(PAGE_FACTS["dashboard"].route).toBe("/");
    expect(getDomainRoutes()["dashboard"].href).toBe("/");
  });
});

describe("every non-dynamic (dashboard)/<route> folder has a PAGE_FACTS entry", () => {
  it("no orphan pages — if a top-level (dashboard) page.tsx exists, page-facts knows about it", () => {
    const dir = join(SRC_APP, "(dashboard)");
    if (!exists(dir)) return;
    const entries = readdirSync(dir);
    const orphans: string[] = [];
    const knownRoutes = new Set(
      Object.values(PAGE_FACTS).map((f) => f.route),
    );
    // The root `(dashboard)/page.tsx` maps to "/" — covered via dashboard.
    knownRoutes.add("/");
    // `setup`, `tools`, `admin/*` — the assistant doesn't need to
    // surface onboarding/dev-internals. Allowlist them explicitly.
    const allowlist = new Set(["setup", "tools", "admin"]);
    for (const name of entries) {
      // Skip layout/page/metadata files, dynamic routes, parallel
      // routes, and co-located test folders.
      if (
        name === "layout.tsx" ||
        name === "page.tsx" ||
        name === "__tests__" ||
        name.startsWith("[") ||
        name.startsWith("(")
      )
        continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (allowlist.has(name)) continue;
      const route = "/" + name;
      if (!knownRoutes.has(route)) orphans.push(route);
    }
    if (orphans.length > 0) {
      throw new Error(
        `Orphan pages (no PAGE_FACTS entry): ${orphans.join(", ")}.\n` +
          `Either add a page-fact so the assistant can help users learn ` +
          `about these pages, or allowlist in routes-exist.test.ts.`,
      );
    }
  });
});
