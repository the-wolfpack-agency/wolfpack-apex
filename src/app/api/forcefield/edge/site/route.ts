/**
 * GET /api/forcefield/edge/site?host=<hostname>
 *
 * The Forcefield Edge app calls this to learn how to serve one public hostname:
 * which tenant it belongs to, the origin to forward allowed traffic to, the
 * per-tenant x-forcefield-edge value, and whether blocking is on. The edge
 * caches the answer briefly (positive and negative), so this is a per-hostname,
 * per-minute call, not a per-request one.
 *
 * PUBLIC: unauthenticated in the session sense (the edge calls it before any
 * user exists), so it is NOT capability-gated. It is authorized by the
 * `x-edge-service-token` header == FORCEFIELD_EDGE_SERVICE_TOKEN (constant-time,
 * >= 32 chars). Unset -> 503 (feature off, never open).
 *
 * The response carries the tenant's origin secret, so it is never cached
 * (no-store) and never logged; the analytics event carries the hostname and
 * whether it resolved, nothing else.
 *
 * Responses: 200 { ok, site }, 400 invalid host, 401 bad token, 404 unknown
 * host, 503 not configured.
 */
import { NextRequest, NextResponse } from "next/server";
import { edgeServiceTokenConfigured, edgeServiceTokenMatches } from "@/lib/forcefield-web/edge-service-token";
import { normalizeEdgeHostname, resolveEdgeSiteByHost } from "@/lib/forcefield-web/edge-sites";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

// PUBLIC: unauthenticated (no user session); authorized by the Edge service
// token header. See the file header.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!edgeServiceTokenConfigured()) {
    return NextResponse.json({ ok: false, error: "edge_disabled" }, { status: 503, headers: NO_STORE });
  }
  if (!edgeServiceTokenMatches(req.headers.get("x-edge-service-token"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const host = normalizeEdgeHostname(new URL(req.url).searchParams.get("host") ?? "");
  if (!host) {
    return NextResponse.json({ ok: false, error: "invalid_host" }, { status: 400, headers: NO_STORE });
  }
  const site = await resolveEdgeSiteByHost(host);
  void trackEvent("forcefield.edge_site_resolved", "system", "forcefield", { host, found: site !== null });
  if (!site) {
    return NextResponse.json({ ok: false, error: "unknown_host" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, site }, { status: 200, headers: NO_STORE });
}
