/**
 * /api/admin/ogiam/enforcement — manage the per-capability gate posture.
 *
 *   GET    -> { policy: [{ capability, mode, updatedAt, updatedBy }] }
 *   PUT    { capability, mode: 'monitor'|'enforce' } -> upsert one posture
 *   DELETE { capability }  (or ?capability=) -> revert a capability to default
 *
 * Capability: settings.manage_team. Every mutation emits
 * ogiam.enforcement_posture_changed (with the previous mode) so the control-plane
 * audit trail records who graduated which capability and when. Setting a posture
 * is the knob that turns the gate from "monitor" to "enforce" for a capability.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import {
  listEnforcementPolicy,
  setEnforcementPolicy,
  deleteEnforcementPolicy,
} from "@/lib/ogiam/enforcement-policy";
import type { OgiamEnforcementMode } from "@/lib/ogiam/types";

const VALID_MODES: OgiamEnforcementMode[] = ["monitor", "enforce"];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const policy = await listEnforcementPolicy(auth.user.workspaceId ?? "default");
  return NextResponse.json({ policy });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { capability?: unknown; mode?: unknown };
  const capability = typeof b.capability === "string" ? b.capability.trim() : "";
  const mode = b.mode as OgiamEnforcementMode;
  if (!capability) {
    return NextResponse.json({ error: "capability is required" }, { status: 400 });
  }
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json({ error: "mode must be 'monitor' or 'enforce'" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const prev = (await listEnforcementPolicy(workspaceId)).find((p) => p.capability === capability);
  await setEnforcementPolicy({ workspaceId, capability, mode, updatedBy: auth.user.id });

  // Changing the gate posture is a security-relevant control-plane action:
  // hash-chain it so the audit trail shows who graduated which capability.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ogiam.enforcement_posture.updated",
    resourceType: "ogiam_enforcement_policy",
    resourceId: `${workspaceId}:${capability}`,
    beforeState: { mode: prev?.mode ?? "default" },
    afterState: { mode },
  });

  trackEvent("ogiam.enforcement_posture_changed", auth.user.id, auth.user.role, {
    capability,
    mode,
    prev_mode: prev?.mode ?? "default",
  });

  return NextResponse.json({ ok: true, capability, mode });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  let capability = url.searchParams.get("capability")?.trim() ?? "";
  if (!capability) {
    try {
      const b = (await req.json()) as { capability?: unknown };
      if (typeof b.capability === "string") capability = b.capability.trim();
    } catch {
      /* no body — fall through to validation below */
    }
  }
  if (!capability) {
    return NextResponse.json({ error: "capability is required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  await deleteEnforcementPolicy(workspaceId, capability);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ogiam.enforcement_posture.reverted",
    resourceType: "ogiam_enforcement_policy",
    resourceId: `${workspaceId}:${capability}`,
    afterState: { mode: "default" },
  });
  trackEvent("ogiam.enforcement_posture_changed", auth.user.id, auth.user.role, {
    capability,
    mode: "default",
    prev_mode: "override",
  });
  return NextResponse.json({ ok: true, capability, mode: "default" });
}
