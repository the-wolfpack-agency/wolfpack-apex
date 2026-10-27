/**
 * POST /api/forcefield/wordpress/connect - the WordPress plugin's Connect button.
 *
 * PUBLIC: unauthenticated by design. The plugin runs on a site that has no
 * Forcefield account yet. Protected by the durable per-IP and per-site rate
 * limits and strict validation; the plugin's random secret (ffp_...) is stored
 * only as a SHA-256 and authorizes the prove + claim steps that follow.
 *
 * { site, email, secret, name? }
 *   201 { ok, mode: "self_serve", requestId, challenge } the plugin stores the
 *       challenge, serves it at /?rest_route=/ogiam-forcefield/v1/challenge and
 *       calls /connect/prove.
 *   202 { ok, mode: "request" } build phase: an address outside the recipient
 *       allowlist is filed for operator review and sent nothing.
 *   400 invalid | 429 rate limited | 503 unavailable. Never 500s.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { hashIp } from "@/lib/forcefield-web/signup";
import { emailDomain } from "@/lib/forcefield-web/recipient-allowlist";
import { startPluginConnect } from "@/lib/forcefield-web/wordpress-connect";
import { START_WINDOW_MS } from "@/lib/forcefield-web/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUBLIC: no session exists; see the file header.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  const meta = extractRequestMetadata(req);
  const r = await startPluginConnect({ raw, ipHash: hashIp(meta.ipAddress) });
  if (r.reason === "invalid") return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  if (r.reason === "rate_limited") return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(START_WINDOW_MS / 1000)) } });
  if (r.reason === "error") return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });

  const mode = r.reason === "ok" ? "self_serve" : "request";
  if (r.requestId) {
    const action = mode === "self_serve" ? "forcefield.wordpress_connect_started" : "forcefield.signup_requested";
    await recordAudit({
      actor: { user_id: "anonymous", role: "public" },
      action,
      resourceType: "forcefield_signup_request",
      resourceId: r.requestId,
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
      afterState: { site: r.site, source: "wordpress_plugin" },
    }).catch(() => {});
    void trackEvent(action, "anonymous", "public", { requestId: r.requestId, site: r.site ?? "", email_domain: emailDomain(String(raw.email ?? "")) ?? "invalid", source: "wordpress_plugin" });
  }
  if (mode === "request") return NextResponse.json({ ok: true, mode }, { status: 202 });
  return NextResponse.json({ ok: true, mode, requestId: r.requestId, challenge: r.challenge }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
