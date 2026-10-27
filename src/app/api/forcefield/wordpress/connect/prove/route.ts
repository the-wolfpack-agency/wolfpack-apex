/**
 * POST /api/forcefield/wordpress/connect/prove - ownership proof by the plugin.
 *
 * PUBLIC: no session; authorized by the plugin's secret (stored only hashed).
 * We fetch the challenge from the plugin on the site itself (SSRF-guarded) and
 * compare it in constant time with the one we issued. On a match the tenant is
 * provisioned and the confirmation email (the sign-in link) is sent.
 *
 * { secret } -> 200 { ok, emailMasked, delivered } | 400 invalid | 401 unknown
 * secret | 409 already verified (with emailMasked) | 422 not verified ({ detail })
 * | 429 | 503.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { provePluginConnect } from "@/lib/forcefield-web/wordpress-connect";
import { VERIFY_WINDOW_MS } from "@/lib/forcefield-web/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUBLIC: no session exists; see the file header.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { secret?: unknown } | null;
  const r = await provePluginConnect(body?.secret);
  const meta = extractRequestMetadata(req);
  switch (r.reason) {
    case "invalid": return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    case "unauthorized": return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    case "already_verified": return NextResponse.json({ ok: false, error: "already_verified", emailMasked: r.emailMasked }, { status: 409 });
    case "rate_limited": return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(VERIFY_WINDOW_MS / 1000)) } });
    case "not_verified":
      void trackEvent("forcefield.wordpress_ownership_failed", "anonymous", "public", { requestId: r.requestId ?? "", reason: r.detail ?? "unknown" });
      return NextResponse.json({ ok: false, error: "not_verified", detail: r.detail }, { status: 422 });
    case "ok": break;
    default: return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  await recordAudit({
    actor: { user_id: "anonymous", role: "public" },
    action: "forcefield.wordpress_ownership_verified",
    resourceType: "forcefield_signup_request",
    resourceId: r.requestId ?? "",
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    // NEVER the challenge or the secret.
    afterState: { tenantId: r.tenantId, siteLabel: r.site, method: "wordpress_plugin" },
  }).catch(() => {});
  void trackEvent("forcefield.wordpress_ownership_verified", "anonymous", "public", {
    requestId: r.requestId ?? "", tenantId: r.tenantId ?? "", site: r.site ?? "", confirm_email_delivered: r.delivered === true,
  });
  return NextResponse.json({ ok: true, emailMasked: r.emailMasked, delivered: r.delivered === true }, { headers: { "Cache-Control": "no-store" } });
}
