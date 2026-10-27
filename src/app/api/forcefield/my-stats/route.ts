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
 * per-tenant credential in the `x-forcefield-token` header: the ingest token
 * (resolved by sha256 hash) or a signed dashboard session from the confirmation
 * link (dashboard-session.ts), either resolving to an ACTIVE tenant; an unknown, disabled, or missing token returns 401 and
 * never another tenant's data. Same posture as forcefield/observe and the
 * site-analytics ingest endpoint. Never 500s: the stats helper degrades to zeros.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveTenantCredential } from "@/lib/forcefield-web/dashboard-session";
import { getTenantActivity } from "@/lib/forcefield-web/tenant-activity";
import { getPublicForcefieldStats } from "@/lib/forcefield-web/public-stats";
import { getTenantBilling, isLicensed } from "@/lib/forcefield-web/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get("x-forcefield-token") ?? "";
  const cred = await resolveTenantCredential(token);
  const tenant = cred?.tenant;
  if (!tenant) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const stats = await getPublicForcefieldStats(30, undefined, tenant.id);
  // Who visited: each agent, what it did, how Forcefield handled it (30 days,
  // synthetic monitor traffic excluded). Degrades to empty, never a 500.
  const activity = await getTenantActivity(tenant.id, new Date(Date.now() - 30 * 86400_000).toISOString());
  // Enforce-to-paid: is this tenant entitled to ACTUALLY block, or watch-only?
  // Drives the honest dashboard labeling ("stopped" vs "caught") + the upgrade
  // prompt. Defaults to watch-only (false) if billing is absent or a read fails,
  // so we never tell a free tenant we blocked when we only watched.
  const billing = await getTenantBilling(tenant.id);
  const enforcing = billing ? isLicensed(billing) : false;
  return NextResponse.json({
    ok: true,
    tenant: { id: tenant.id, name: tenant.name, siteLabel: tenant.siteLabel },
    stats,
    activity,
    enforcing,
    plan: billing?.plan ?? "none",
  });
}
