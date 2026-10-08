/**
 * POST /api/admin/forcefield/tenants/manage { id, action }
 *
 * Lifecycle control for an onboarded Forcefield tenant:
 *   action: "disable" -> kill a leaked/abused token (reversible); the token stops
 *                        resolving immediately and the edge falls back to shared.
 *   action: "enable"  -> re-activate a disabled tenant.
 *   action: "rotate"  -> issue a NEW token (old one stops working); returned ONCE.
 *
 * Capability: settings.manage_team. Every lifecycle change is audited; the audit
 * NEVER carries the token.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { setTenantStatus, rotateTenantToken, setTenantSharesIntel, setTenantPlatform, setTenantEnforce } from "@/lib/forcefield-web/tenants";
import { isConnectorKey } from "@/lib/forcefield-web/connectors";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["disable", "enable", "rotate", "intel_on", "intel_off", "set_platform", "enforce_on", "enforce_off"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown; platform?: unknown };
  const id = String(body.id ?? "");
  const action = String(body.action ?? "") as Action;
  if (!id || !ACTIONS.includes(action)) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const meta = extractRequestMetadata(req);
  const auditBase = {
    actor: { user_id: auth.user.id, role: auth.user.role },
    resourceType: "forcefield_tenant",
    resourceId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  };

  if (action === "rotate") {
    const res = await rotateTenantToken(id);
    if (!res) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await recordAudit({ ...auditBase, action: "forcefield.tenant_token_rotated" }).catch(() => {});
    void trackEvent("forcefield.tenant_token_rotated", auth.user.id, auth.user.role, { tenantId: id });
    return NextResponse.json({ ok: true, token: res.token });
  }

  if (action === "set_platform") {
    const platform = body.platform;
    if (!isConnectorKey(platform)) {
      return NextResponse.json({ ok: false, error: "invalid_platform" }, { status: 400 });
    }
    const done = await setTenantPlatform(id, platform);
    if (!done) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await recordAudit({ ...auditBase, action: "forcefield.tenant_platform_set", afterState: { platform } }).catch(() => {});
    void trackEvent("forcefield.tenant_platform_set", auth.user.id, auth.user.role, { tenantId: id, platform });
    return NextResponse.json({ ok: true, platform });
  }

  if (action === "enforce_on" || action === "enforce_off") {
    const enabled = action === "enforce_on";
    const done = await setTenantEnforce(id, enabled);
    if (!done) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await recordAudit({ ...auditBase, action: "forcefield.tenant_enforce_set", afterState: { enforceEnabled: enabled } }).catch(() => {});
    void trackEvent("forcefield.tenant_enforce_set", auth.user.id, auth.user.role, { tenantId: id, enforce: enabled });
    return NextResponse.json({ ok: true, enforceEnabled: enabled });
  }

  if (action === "intel_on" || action === "intel_off") {
    const shares = action === "intel_on";
    const done = await setTenantSharesIntel(id, shares);
    if (!done) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await recordAudit({ ...auditBase, action: "forcefield.tenant_intel_updated", afterState: { sharesIntel: shares } }).catch(() => {});
    void trackEvent("forcefield.tenant_intel_updated", auth.user.id, auth.user.role, { tenantId: id, sharesIntel: shares });
    return NextResponse.json({ ok: true, sharesIntel: shares });
  }

  const status = action === "disable" ? "disabled" : "active";
  const ok = await setTenantStatus(id, status);
  if (!ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  await recordAudit({ ...auditBase, action: `forcefield.tenant_${action}d`, afterState: { status } }).catch(() => {});
  void trackEvent(action === "disable" ? "forcefield.tenant_disabled" : "forcefield.tenant_enabled", auth.user.id, auth.user.role, { tenantId: id });
  return NextResponse.json({ ok: true, status });
}
