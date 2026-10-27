/**
 * POST /api/forcefield/wordpress/connect/claim - the plugin collects its site key.
 *
 * PUBLIC: no session; authorized by the plugin's secret (stored only hashed).
 * Answers 202 until the owner clicks the sign-in link in the confirmation
 * email; then returns the site key exactly once.
 *
 * { secret } -> 200 { ok, token, site } | 202 { ok:false, status: "awaiting_confirmation" }
 * | 400 invalid | 401 unknown secret | 409 already linked | 422 not verified | 429 | 503.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { claimPluginToken, CLAIM_WINDOW_MS } from "@/lib/forcefield-web/wordpress-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// PUBLIC: no session exists; see the file header.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { secret?: unknown } | null;
  const r = await claimPluginToken(body?.secret);
  switch (r.reason) {
    case "invalid": return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    case "unauthorized": return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    case "not_verified": return NextResponse.json({ ok: false, error: "not_verified" }, { status: 422 });
    case "awaiting_confirmation": return NextResponse.json({ ok: false, status: "awaiting_confirmation", emailMasked: r.emailMasked }, { status: 202, headers: noStore });
    case "already_linked": return NextResponse.json({ ok: false, error: "already_linked" }, { status: 409 });
    case "rate_limited": return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(CLAIM_WINDOW_MS / 1000)) } });
    case "ok": break;
    default: return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: `forcefield_tenant:${r.tenantId}`, role: "tenant" },
    action: "forcefield.wordpress_linked",
    resourceType: "forcefield_tenant",
    resourceId: r.tenantId ?? "",
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    // NEVER the key.
    afterState: { requestId: r.requestId, siteLabel: r.site },
  }).catch(() => {});
  void trackEvent("forcefield.wordpress_linked", `forcefield_tenant:${r.tenantId}`, "tenant", { tenantId: r.tenantId ?? "", requestId: r.requestId ?? "", site: r.site ?? "" });
  return NextResponse.json({ ok: true, token: r.token, site: r.site }, { headers: noStore });
}
