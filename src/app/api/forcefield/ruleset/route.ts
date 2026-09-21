/**
 * GET /api/forcefield/ruleset
 *
 * PUBLIC: serves the Forcefield detection ruleset (allowlisted agents, trap paths,
 * sensitive-path list, tool signatures) that every connected site fetches and
 * caches. This is the "update once, all sites follow" seam: change the ruleset
 * here and each site picks it up within its cache TTL, no per-site redeploy. The
 * payload is non-sensitive by design (it is detection rules, not secrets), so the
 * endpoint is intentionally unauthenticated and CDN-cacheable - sites on any
 * origin must be able to read it, and it must not depend on a session.
 *
 * Today it returns the bundled DEFAULT_RULESET; a DB-backed override (editable
 * from the admin board) can replace the source without changing this contract.
 *
 * Responses: 200 { ruleset }.
 */
import { NextResponse } from "next/server";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    { ruleset: DEFAULT_RULESET },
    {
      status: 200,
      headers: {
        // Cache at the CDN for 5 minutes, serve stale while revalidating - the
        // ruleset changes rarely and a site's own fetch cache is the primary layer.
        "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}
