/**
 * POST /api/forcefield/onboarding/verify - one-click ownership proof.
 *
 * PUBLIC: no account exists yet; authorized by the onboarding setup key
 * (header x-forcefield-setup, stored only hashed). Runs the platform-scan
 * ownership check (DNS TXT, then the well-known file). On success it provisions
 * the tenant, returns its ingest token ONCE with the quick-start, and sends the
 * alert-address confirmation email through the guarded sender.
 *
 * 200 verified | 401 unknown key | 409 already verified | 422 not verified yet
 * (per-method reasons) | 429 too many attempts | 503 unavailable.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { verifyOwnership, VERIFY_WINDOW_MS } from "@/lib/forcefield-web/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const key = req.headers.get("x-forcefield-setup") ?? "";
  if (!key) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const r = await verifyOwnership(key);
  const meta = extractRequestMetadata(req);

  switch (r.reason) {
    case "unauthorized":
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    case "already_verified":
      return NextResponse.json({ ok: false, error: "already_verified" }, { status: 409 });
    case "rate_limited":
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(VERIFY_WINDOW_MS / 1000)) } });
    case "not_verified":
      void trackEvent("forcefield.onboarding_ownership_failed", "anonymous", "public", {
        requestId: r.requestId ?? "",
        reasons: (r.attempts ?? []).map((a) => `${a.method}:${a.reason}`).join(","),
      });
      return NextResponse.json({ ok: false, error: "not_verified", attempts: r.attempts ?? [] }, { status: 422 });
    case "ok":
      break;
    default:
      return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  await recordAudit({
    actor: { user_id: "anonymous", role: "public" },
    action: "forcefield.onboarding_ownership_verified",
    resourceType: "forcefield_signup_request",
    resourceId: r.requestId ?? "",
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    // NEVER the token.
    afterState: { tenantId: r.tenant?.id, siteLabel: r.tenant?.siteLabel, method: r.method },
  }).catch(() => {});
  void trackEvent("forcefield.onboarding_ownership_verified", "anonymous", "public", {
    requestId: r.requestId ?? "",
    tenantId: r.tenant?.id ?? "",
    method: r.method ?? "",
    confirm_email_delivered: r.notify?.delivered === true,
  });
  return NextResponse.json({
    ok: true,
    tenant: { id: r.tenant!.id, name: r.tenant!.name, siteLabel: r.tenant!.siteLabel },
    token: r.token,
    quickstart: r.quickstart,
    method: r.method,
    notify: r.notify,
  }, { headers: { "Cache-Control": "no-store" } });
}
