/**
 * Forcefield self-serve onboarding, step 1 + state.
 *
 * PUBLIC: unauthenticated by design. A person setting up Forcefield has no
 * account yet. POST is protected by the durable per-IP rate limit, a honeypot
 * field and strict validation; GET is authorized by the one-time setup key the
 * POST returned (header x-forcefield-setup), stored only as a SHA-256.
 *
 * POST { siteUrl, email, name?, note? }
 *   201 { ok, mode: "self_serve", requestId, setupKey, site, email, ownership }
 *       the address is on the recipient allowlist: continue to /forcefield/setup.
 *   202 { ok, mode: "request" } any other address (build phase): filed in the
 *       operator-reviewed queue; nothing is sent to it. A tripped honeypot also
 *       answers 202 so a bot learns nothing.
 *   400 invalid input, 429 rate limited. Never 500s.
 * GET  -> 200 { ok, state } | 401 (missing/unknown setup key) | 503.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { hashIp } from "@/lib/forcefield-web/signup";
import { startForcefieldOnboarding, getOnboardingState, START_WINDOW_MS } from "@/lib/forcefield-web/onboarding";
import { emailDomain } from "@/lib/forcefield-web/recipient-allowlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const meta = extractRequestMetadata(req);
  const result = await startForcefieldOnboarding({ raw, ipHash: hashIp(meta.ipAddress) });

  if (result.reason === "rate_limited") {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(START_WINDOW_MS / 1000)) } });
  }
  if (result.reason === "invalid") return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  if (result.reason === "error") return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  if (result.reason === "honeypot") return NextResponse.json({ ok: true, mode: "request" }, { status: 202 });

  const mode = result.reason === "ok" ? "self_serve" : "request";
  if (result.requestId) {
    await recordAudit({
      actor: { user_id: "anonymous", role: "public" },
      action: mode === "self_serve" ? "forcefield.onboarding_started" : "forcefield.signup_requested",
      resourceType: "forcefield_signup_request",
      resourceId: result.requestId,
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    }).catch(() => {});
    void trackEvent(mode === "self_serve" ? "forcefield.onboarding_started" : "forcefield.signup_requested", "anonymous", "public", {
      requestId: result.requestId,
      email_domain: emailDomain(String(raw.email ?? "")) ?? "invalid",
    });
  }
  if (mode === "request") return NextResponse.json({ ok: true, mode }, { status: 202 });
  return NextResponse.json(
    { ok: true, mode, requestId: result.requestId, setupKey: result.setupKey, site: result.site, email: result.email, ownership: result.ownership },
    { status: 201 },
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const key = req.headers.get("x-forcefield-setup") ?? "";
  if (!key) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const r = await getOnboardingState(key);
  if (!r.ok) {
    return r.reason === "unauthorized"
      ? NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, state: r.state }, { headers: { "Cache-Control": "no-store" } });
}
