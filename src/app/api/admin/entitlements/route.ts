/**
 * /api/admin/entitlements - manage the OGIAM product entitlements for the
 * caller's workspace.
 *
 *   GET  -> every OGIAM feature with its env default, the workspace override,
 *           and the effective state (for the admin toggle UI).
 *   POST { feature, enabled }  -> set an override. enabled=null CLEARS it
 *           (revert to the env default). enabled true/false sets it.
 *
 * Capability: settings.manage_team. Every change is audited inside setEntitlement
 * (tenancy.entitlement_changed). Workspace-scoped: an admin only ever touches
 * their own workspace's entitlements.
 *
 * Returns: 200 | 400 (bad body) | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit } from "@/lib/audit-log";
import { listEntitlements, setEntitlement, isKnownFeature } from "@/lib/tenancy/entitlements";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const entitlements = await listEntitlements(auth.user.workspaceId ?? "default");
  return NextResponse.json({ entitlements });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { feature?: unknown; enabled?: unknown };
  const feature = typeof b.feature === "string" ? b.feature : "";
  if (!isKnownFeature(feature)) {
    return NextResponse.json({ error: "unknown feature" }, { status: 400 });
  }
  // enabled: true | false | null (clear). Anything else is a bad request.
  if (b.enabled !== true && b.enabled !== false && b.enabled !== null) {
    return NextResponse.json({ error: "enabled must be true, false, or null" }, { status: 400 });
  }

  const ok = await setEntitlement(
    { workspaceId: auth.user.workspaceId ?? "default", userId: auth.user.id, role: auth.user.role },
    feature,
    b.enabled,
  );
  if (!ok) return NextResponse.json({ error: "could not update entitlement" }, { status: 400 });

  // Turning a product on/off for a workspace is a security-relevant config change:
  // record it in the tamper-evident audit log (setEntitlement also emits analytics).
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "tenancy.entitlement_changed",
    resourceType: "entitlement",
    resourceId: `${auth.user.workspaceId ?? "default"}:${feature}`,
    afterState: { enabled: b.enabled === null ? "cleared" : b.enabled },
  });

  return NextResponse.json({ ok: true });
}
