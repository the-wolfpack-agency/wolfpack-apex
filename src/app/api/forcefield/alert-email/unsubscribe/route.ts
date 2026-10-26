/**
 * POST /api/forcefield/alert-email/unsubscribe - the one link in every email.
 *
 * PUBLIC: the signed unsubscribe token (bound to the tenant and the address it
 * was sent to) IS the credential. Posted from /forcefield/unsubscribe on a click.
 *
 * { token } -> 200 { ok, site } | 400 invalid | 404 address no longer on file |
 * 410 expired | 503. Idempotent for the same address.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { unsubscribeNotify } from "@/lib/forcefield-web/tenant-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = { invalid: 400, not_found: 404, expired: 410, error: 503 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  if (!body || typeof body.token !== "string" || !body.token) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const r = await unsubscribeNotify(body.token);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.reason }, { status: STATUS[r.reason] ?? 503 });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: `forcefield_tenant:${r.tenantId}`, role: "tenant" },
    action: "forcefield.alert_email_unsubscribed",
    resourceType: "forcefield_tenant",
    resourceId: r.tenantId ?? "",
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
  }).catch(() => {});
  void trackEvent("forcefield.alert_email_unsubscribed", `forcefield_tenant:${r.tenantId}`, "tenant", { tenantId: r.tenantId ?? "" });
  return NextResponse.json({ ok: true, site: r.site });
}
