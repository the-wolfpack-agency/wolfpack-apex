/**
 * POST /api/forcefield/onboarding/concierge - "we'll do it for you".
 *
 * PUBLIC: no apex session; authorized by the onboarding setup key
 * (x-forcefield-setup) or the tenant's ingest token (x-forcefield-token). Records
 * the connect request for the operator, who sees it on /admin/forcefield/signups.
 * Nothing is emailed. 200 | 400 | 401 | 503.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { requestConcierge } from "@/lib/forcefield-web/onboarding";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const setupKey = req.headers.get("x-forcefield-setup") ?? "";
  const token = req.headers.get("x-forcefield-token") ?? "";
  if (!setupKey && !token) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  if (body.note !== undefined && typeof body.note !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  let by: { setupKey: string } | { tenantId: string };
  if (setupKey) {
    by = { setupKey };
  } else {
    const tenant = await resolveTenantByToken(token);
    if (!tenant) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    by = { tenantId: tenant.id };
  }
  const r = await requestConcierge(by, body.note);
  if (r.reason === "not_found") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!r.ok) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: "anonymous", role: "public" },
    action: "forcefield.onboarding_concierge_requested",
    resourceType: "forcefield_signup_request",
    resourceId: r.requestId ?? "",
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
  }).catch(() => {});
  void trackEvent("forcefield.onboarding_concierge_requested", "anonymous", "public", { requestId: r.requestId ?? "" });
  return NextResponse.json({ ok: true });
}
