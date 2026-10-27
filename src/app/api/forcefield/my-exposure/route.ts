/**
 * GET /api/forcefield/my-exposure - "Is your server exposed?" for a CLIENT's own
 * site: the latest server inventory the WordPress plugin reported, matched
 * against the actively exploited flaws Forcefield tracks.
 *
 * PUBLIC: not capability-gated in the session sense; a client's dashboard has
 * no apex session. Locked down by the per-tenant credential in the
 * x-forcefield-token header (the site key, or the signed dashboard session from
 * the confirmation link), resolving to an ACTIVE tenant; unknown, disabled or
 * missing is 401 and never another tenant's data. Same posture as my-stats.
 *
 * 200 { ok, report: null | {...} } (null = the plugin has not reported yet)
 * | 401 | 503 when the read fails. Never 500.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveTenantCredential } from "@/lib/forcefield-web/dashboard-session";
import { getServerExposure } from "@/lib/forcefield-web/server-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// PUBLIC: no session exists; the x-forcefield-token credential is the auth (see the file header).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cred = await resolveTenantCredential(req.headers.get("x-forcefield-token") ?? "");
  if (!cred) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: noStore });
  const view = await getServerExposure(cred.tenant.id);
  if (!view) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503, headers: noStore });
  return NextResponse.json({ ok: true, report: view.report }, { headers: noStore });
}
