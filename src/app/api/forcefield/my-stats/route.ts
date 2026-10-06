/**
 * GET /api/forcefield/my-stats - a CLIENT's own Forcefield numbers, scoped to
 * their tenant.
 *
 * The caller presents their ingest token (header x-forcefield-token); we resolve
 * it to a tenant and return the SAME safe aggregate shape as the public endpoint,
 * but filtered to that tenant's events only. This is the isolation guarantee at
 * the API boundary: a token can only ever read its own tenant's data, and an
 * unknown/disabled token gets 401, never another tenant's numbers.
 *
 * PUBLIC: not capability-gated in the session sense - a client wires this into
 * their own dashboard where no apex user session exists. It is locked down by the
 * per-tenant ingest token in the `x-forcefield-token` header, resolved by sha256
 * hash to an ACTIVE tenant; an unknown, disabled, or missing token returns 401 and
 * never another tenant's data. Same posture as forcefield/observe and the
 * site-analytics ingest endpoint. Never 500s: the stats helper degrades to zeros.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";
import { getPublicForcefieldStats } from "@/lib/forcefield-web/public-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get("x-forcefield-token") ?? "";
  const tenant = await resolveTenantByToken(token);
  if (!tenant) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const stats = await getPublicForcefieldStats(30, undefined, tenant.id);
  return NextResponse.json({
    ok: true,
    tenant: { id: tenant.id, name: tenant.name, siteLabel: tenant.siteLabel },
    stats,
  });
}
