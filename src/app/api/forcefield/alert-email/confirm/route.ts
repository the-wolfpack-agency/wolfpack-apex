/**
 * POST /api/forcefield/alert-email/confirm - the double opt-in.
 *
 * PUBLIC: the signed, expiring, single-use token from the confirmation email IS
 * the credential (only its SHA-256 is stored). The page /forcefield/confirm posts
 * it on an explicit click, so a mail scanner that fetches the link confirms
 * nothing.
 *
 * The link is also the owner's SIGN-IN: a successful confirmation returns a
 * signed dashboard session (dashboard-session.ts, purpose ff_dashboard) so the
 * browser that clicked lands on its dashboard without ever handling a site key
 * (the WordPress plugin path). It is single-use like the confirmation itself.
 *
 * { token } -> 200 { ok, site, dashboardToken } | 400 invalid | 404 not found (address changed or
 * removed) | 409 already confirmed | 410 expired | 503.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { confirmNotifyEmail } from "@/lib/forcefield-web/tenant-notify";
import { mintDashboardSession } from "@/lib/forcefield-web/dashboard-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = { invalid: 400, not_found: 404, already_confirmed: 409, expired: 410, error: 503 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  if (!body || typeof body.token !== "string" || !body.token) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const r = await confirmNotifyEmail(body.token);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.reason, site: r.site }, { status: STATUS[r.reason] ?? 503 });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: `forcefield_tenant:${r.tenantId}`, role: "tenant" },
    action: "forcefield.alert_email_confirmed",
    resourceType: "forcefield_tenant",
    resourceId: r.tenantId ?? "",
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
  }).catch(() => {});
  void trackEvent("forcefield.alert_email_confirmed", `forcefield_tenant:${r.tenantId}`, "tenant", { tenantId: r.tenantId ?? "", site: r.site ?? "" });
  const dashboardToken = r.tenantId ? mintDashboardSession(r.tenantId) : undefined;
  if (dashboardToken) {
    void trackEvent("forcefield.dashboard_signed_in", `forcefield_tenant:${r.tenantId}`, "tenant", { tenantId: r.tenantId ?? "", via: "confirm_link" });
  }
  return NextResponse.json({ ok: true, site: r.site, dashboardToken }, { headers: { "Cache-Control": "no-store" } });
}
