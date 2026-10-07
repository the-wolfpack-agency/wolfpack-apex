/**
 * POST /api/admin/forcefield/tenants/billing { id, plan?, status?, provider? }
 *
 * Operator sets a tenant's licensing/subscription state MANUALLY - the path for an
 * existing client we license directly (no Stripe). The self-serve SaaS path keeps
 * the SAME state in sync via the Stripe webhook; this is the human equivalent.
 *
 * Capability: settings.manage_team. Audited. Decoupled from the ingest path - this
 * records the commercial state; the hard entitlement kill is disable/enable.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { setTenantBilling, getTenantBilling, FORCEFIELD_PLANS, SUBSCRIPTION_STATUSES, type ForcefieldPlan, type SubscriptionStatus } from "@/lib/forcefield-web/billing";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; plan?: unknown; status?: unknown; provider?: unknown };
  const id = String(body.id ?? "");
  const plan = body.plan === undefined ? undefined : String(body.plan);
  const status = body.status === undefined ? undefined : String(body.status);
  if (!id) return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  if (plan !== undefined && !(FORCEFIELD_PLANS as readonly string[]).includes(plan)) {
    return NextResponse.json({ ok: false, error: "invalid_plan" }, { status: 400 });
  }
  if (status !== undefined && !(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ ok: false, error: "invalid_status" }, { status: 400 });
  }

  const ok = await setTenantBilling(id, {
    plan: plan as ForcefieldPlan | undefined,
    status: status as SubscriptionStatus | undefined,
    provider: "manual",
  });
  if (!ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.tenant_license_updated",
    resourceType: "forcefield_tenant",
    resourceId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { plan, status, provider: "manual" },
  }).catch(() => {});
  void trackEvent("forcefield.tenant_license_updated", auth.user.id, auth.user.role, { tenantId: id, plan: plan ?? "", status: status ?? "", provider: "manual" });

  const billing = await getTenantBilling(id);
  return NextResponse.json({ ok: true, billing });
}
