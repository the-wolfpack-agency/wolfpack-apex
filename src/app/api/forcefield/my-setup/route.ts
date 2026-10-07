/**
 * GET /api/forcefield/my-setup - a CLIENT's own onboarding payload.
 *
 * The lowest-friction path to live: the client presents their ingest token
 * (header x-forcefield-token); we return the exact copy-paste quick-start for
 * their token + site (both adapters) AND a live connection signal (have we seen
 * any traffic from their site yet). So a client can self-serve from "I have a
 * token" to "Connected" on the dashboard, with no operator involvement and no
 * separate docs.
 *
 * PUBLIC: not session-gated - a client uses this from their own dashboard where no
 * apex session exists. Locked down by the per-tenant token resolved by sha256
 * hash to an ACTIVE tenant; unknown/disabled/missing -> 401, never another
 * tenant's data. Same posture as my-stats. The raw token is echoed back ONLY to
 * the holder of that token (it is in the request), never stored or logged here.
 * Never 500s: the connection signal degrades to "not connected" on any error.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";
import { buildTenantQuickstart } from "@/lib/forcefield-web/tenant-quickstart";
import { getTenantConnection } from "@/lib/forcefield-web/public-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get("x-forcefield-token") ?? "";
  const tenant = await resolveTenantByToken(token);
  if (!tenant) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // The caller already holds the raw token (they sent it); echoing it in the
  // ready-to-paste config is safe and is the whole point of self-serve setup.
  const quickstart = buildTenantQuickstart(tenant, token);
  const connection = await getTenantConnection(tenant.id);
  return NextResponse.json({
    ok: true,
    tenant: { id: tenant.id, name: tenant.name, siteLabel: tenant.siteLabel },
    quickstart,
    connection,
  });
}
