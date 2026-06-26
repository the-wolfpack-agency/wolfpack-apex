/**
 * Seed route manifests for known scan targets.
 *
 * A manifest is the set of routes + their expected auth behavior that a scan
 * crawls. This is a curated seed (representative journeys across the platform),
 * not the full surface — the honest first step. A later enhancement derives the
 * manifest automatically (sitemap.xml, the target's nav component, or a crawl of
 * server-rendered links) and merges it here; the engine does not care where the
 * routes come from.
 *
 * wolfpack-auto: a dealer platform whose /admin surface is auth-gated (an
 * unauthenticated request must redirect to /admin/login or 401 — anything else
 * is a finding). Public routes (storefront, the customer payment calculator)
 * must serve 200.
 */

import type { ScanRouteSpec } from "./types";
import type { ApiEndpointSpec } from "./api-probe";

/** A static-source-scan target: which repo + which source files to read and run
 *  the bug detectors over (the white-box layer that catches client-side defects
 *  the black-box HTTP crawl cannot see). */
export interface StaticScanTarget {
  owner: string;
  repo: string;
  ref?: string;
  paths: string[];
}

/** Form-login config: the connector credential to read username/password from,
 *  and where/how to POST it to establish an authenticated session. */
export interface LoginConfig {
  connectorName: string;
  loginPath: string;
  sessionCookieName: string;
}

export interface ScanManifest {
  baseUrl: string;
  routes: ScanRouteSpec[];
  static?: StaticScanTarget;
  /** Present when the platform requires form login for an authenticated scan. */
  login?: LoginConfig;
  /** Endpoints for the gray-box API contract probe (auth + validation checks). */
  apiEndpoints?: ApiEndpointSpec[];
}

const WOLFPACK_AUTO: ScanRouteSpec[] = [
  // Public surface — must serve content.
  { path: "/", journey: "Storefront home", auth: "public" },
  { path: "/inventory", journey: "Public inventory listing", auth: "public" },
  { path: "/api/inventory?limit=1", journey: "Inventory API (read)", auth: "public" },
  { path: "/admin/login", journey: "Admin sign-in", auth: "public" },
  // Protected admin journeys — must redirect/401 when unauthenticated.
  { path: "/admin", journey: "Admin dashboard", auth: "required" },
  { path: "/admin/leads", journey: "Lead inbox", auth: "required" },
  { path: "/admin/inventory", journey: "Inventory management", auth: "required" },
  { path: "/admin/deals", journey: "Deal desking", auth: "required" },
  { path: "/admin/customers", journey: "Customer 360", auth: "required" },
  { path: "/admin/accounting/export", journey: "GL export", auth: "required" },
  { path: "/admin/service/appointments", journey: "Service appointments", auth: "required" },
  { path: "/admin/settings", journey: "Settings", auth: "required" },
];

// wolfpack-beyond: a product platform with email+password form login
// (POST /api/auth/login -> HttpOnly `session` cookie). An agent connects via a
// username/password Connection, logs in, and scans + probes it AUTHENTICATED.
const WOLFPACK_BEYOND: ScanRouteSpec[] = [
  { path: "/login", journey: "Login", auth: "public" },
  { path: "/dashboard", journey: "Dashboard", auth: "required" },
  { path: "/assistant", journey: "Assistant", auth: "required" },
  { path: "/studio", journey: "Studio (photo gen)", auth: "required" },
  { path: "/skus", journey: "SKUs", auth: "required" },
  { path: "/content", journey: "Content audit", auth: "required" },
  { path: "/library", journey: "Asset library", auth: "required" },
  { path: "/guides", journey: "Guides", auth: "required" },
  { path: "/analytics", journey: "Analytics", auth: "required" },
  { path: "/governance", journey: "Governance", auth: "required" },
  { path: "/audit", journey: "Audit log", auth: "required" },
  { path: "/account", journey: "Account", auth: "required" },
];

const WOLFPACK_BEYOND_API: ApiEndpointSpec[] = [
  { path: "/api/dashboard", method: "GET", journey: "Dashboard data", requiresAuth: true },
  { path: "/api/brands", method: "GET", journey: "Brands list", requiresAuth: true },
  { path: "/api/library", method: "GET", journey: "Asset library", requiresAuth: true },
  // Invalid SKU ingest must be rejected by validation BEFORE any write.
  { path: "/api/skus", method: "POST", journey: "SKU ingest", requiresAuth: true, invalidBody: {}, expectRejectStatuses: [400, 422] },
];

export const SCAN_MANIFESTS: Record<string, ScanManifest> = {
  "wolfpack-beyond": {
    baseUrl: "https://beyond-sku.vercel.app",
    routes: WOLFPACK_BEYOND,
    login: { connectorName: "wolfpack-beyond", loginPath: "/api/auth/login", sessionCookieName: "session" },
    apiEndpoints: WOLFPACK_BEYOND_API,
    static: {
      owner: "the-wolfpack-agency",
      repo: "wolfpack-beyond",
      ref: "main",
      paths: ["src/app/dashboard/page.tsx", "src/app/login/page.tsx"],
    },
  },
  "wolfpack-auto": {
    baseUrl: "https://wolfpack-auto.vercel.app",
    routes: WOLFPACK_AUTO,
    // White-box source scan: the high-risk admin pages flagged during platform
    // mapping (fetch-without-res.ok silent blanks, hardcoded tenant id). A seed
    // path set; repo-tree discovery is the next layer and extends this list.
    static: {
      owner: "the-wolfpack-agency",
      repo: "wolfpack-auto",
      ref: "main",
      paths: [
        "src/app/admin/heatmaps/page.tsx",
        "src/app/admin/customers/page.tsx",
        "src/app/admin/customers/[id]/page.tsx",
        "src/app/admin/leads/page.tsx",
        "src/app/admin/inventory/page.tsx",
        "src/app/admin/settings/page.tsx",
        "src/app/admin/accounting/export/page.tsx",
        "src/app/admin/deals/[dealId]/page.tsx",
        "src/app/admin/desking/page.tsx",
      ],
    },
  },
};

export function getScanManifest(platform: string): ScanManifest | null {
  return SCAN_MANIFESTS[platform] ?? null;
}

/** The scan targets the UI offers — drives the platform selector so an operator
 *  picks WHICH platform to scan (and the findings list labels each by platform). */
export function listScanTargets(): { platform: string; baseUrl: string; hasStatic: boolean; hasApi: boolean; hasLogin: boolean }[] {
  return Object.entries(SCAN_MANIFESTS).map(([platform, m]) => ({
    platform,
    baseUrl: m.baseUrl,
    hasStatic: !!m.static,
    hasApi: !!m.apiEndpoints?.length,
    hasLogin: !!m.login,
  }));
}
