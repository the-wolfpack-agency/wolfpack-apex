/**
 * GET /api/forcefield/public-stats - PUBLIC, unauthenticated, safe aggregate
 * Forcefield numbers for the marketing site (ogiam.com/forcefield).
 *
 * Exposes ONLY network-wide COUNTS (agents seen / welcomed / trapped / probed /
 * payloads / hostile / sites, plus the attack-family breakdown). No per-request
 * detail, no operator key, no path, no IP, no PII - nothing that identifies a
 * visitor or a client. This is the proof the marketing page shows, and it is safe
 * to serve to anyone.
 *
 * CORS-open (read-only aggregate) so the marketing origin can fetch it, and
 * edge-cached (s-maxage) so a public page cannot hammer the database. Never 500s:
 * the stats helper degrades to zeros on any error.
 */
import { NextResponse } from "next/server";
import { getPublicForcefieldStats } from "@/lib/forcefield-web/public-stats";

export const runtime = "nodejs";
// Revalidate at the edge: the DB is hit at most once per window, not per visitor.
export const revalidate = 300;

export async function GET(): Promise<NextResponse> {
  const stats = await getPublicForcefieldStats(30);
  return NextResponse.json(
    { stats },
    {
      headers: {
        // Public, read-only aggregate: safe to share with any origin.
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        // Edge-cache 5 min, serve stale for an hour while revalidating - a public
        // page stays fast and the database is barely touched.
        "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
      },
    },
  );
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}
