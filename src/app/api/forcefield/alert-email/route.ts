/**
 * The tenant's Forcefield alert address.
 *
 * PUBLIC: not session-gated. A client manages this from their own dashboard,
 * where no apex session exists; authorized by the tenant's ingest token
 * (x-forcefield-token, resolved by SHA-256 to an ACTIVE tenant), same posture as
 * my-setup and my-stats. A request can only ever read or change its own tenant.
 *
 * GET    -> 200 { ok, notify: { email, status, confirmedAt, restricted } } | 401
 * PUT    { email } -> 200 { ok, status: "pending", delivered } (a confirmation
 *        link is emailed; setting the same address again re-sends it)
 *        | 400 invalid | 401 | 403 not_allowed (not on the recipient allowlist
 *        during the build phase) | 429 too many confirmation emails | 503
 * DELETE -> 200 { ok } (address removed; nothing more is sent) | 401 | 503
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { resolveTenantByToken, type ForcefieldTenant } from "@/lib/forcefield-web/tenants";
import { getNotifyState, setNotifyEmail, removeNotifyEmail, CONFIRM_SEND_WINDOW_MS } from "@/lib/forcefield-web/tenant-notify";
import { isBuildPhase, emailDomain } from "@/lib/forcefield-web/recipient-allowlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tenantFrom(req: NextRequest): Promise<ForcefieldTenant | null> {
  return resolveTenantByToken(req.headers.get("x-forcefield-token") ?? "");
}
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const tenant = await tenantFrom(req);
  if (!tenant) return unauthorized();
  const notify = await getNotifyState(tenant.id);
  if (!notify) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true, notify: { ...notify, restricted: isBuildPhase() } }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const tenant = await tenantFrom(req);
  if (!tenant) return unauthorized();
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  if (!body || typeof body.email !== "string") return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  const r = await setNotifyEmail(tenant.id, body.email);
  switch (r.reason) {
    case "invalid": return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    case "not_allowed": return NextResponse.json({ ok: false, error: "not_allowed" }, { status: 403 });
    case "rate_limited": return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(CONFIRM_SEND_WINDOW_MS / 1000)) } });
    case "not_found": return unauthorized();
    case "ok": break;
    default: return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: `forcefield_tenant:${tenant.id}`, role: "tenant" },
    action: "forcefield.alert_email_set",
    resourceType: "forcefield_tenant",
    resourceId: tenant.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { emailDomain: emailDomain(body.email) ?? "", status: "pending" },
  }).catch(() => {});
  void trackEvent("forcefield.alert_email_set", `forcefield_tenant:${tenant.id}`, "tenant", { tenantId: tenant.id, delivered: r.delivered === true });
  return NextResponse.json({ ok: true, status: "pending", delivered: r.delivered === true });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const tenant = await tenantFrom(req);
  if (!tenant) return unauthorized();
  const r = await removeNotifyEmail(tenant.id);
  if (r.reason === "not_found") return unauthorized();
  if (!r.ok) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: `forcefield_tenant:${tenant.id}`, role: "tenant" },
    action: "forcefield.alert_email_removed",
    resourceType: "forcefield_tenant",
    resourceId: tenant.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
  }).catch(() => {});
  void trackEvent("forcefield.alert_email_removed", `forcefield_tenant:${tenant.id}`, "tenant", { tenantId: tenant.id });
  return NextResponse.json({ ok: true });
}
