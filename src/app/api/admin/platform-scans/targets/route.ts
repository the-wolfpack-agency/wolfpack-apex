import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { listScanTargets } from "@/lib/platform-scan/manifests";
import { validateScanTargetInput, saveScanTarget, removeScanTarget } from "@/lib/platform-scan/targets-store";

/**
 * GET -> the scan targets the operator can choose from (curated + onboarded +
 * connector). POST -> ONBOARD a client target (register a full stored manifest).
 * DELETE ?platform= -> offboard (deactivate). Gated on settings.manage_team.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";
  return NextResponse.json({ targets: await listScanTargets(workspaceId) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const body = await req.json().catch(() => ({}));
  const platform = typeof (body as { platform?: unknown }).platform === "string" ? (body as { platform: string }).platform.trim() : "";
  if (!platform) return NextResponse.json({ error: "platform_required" }, { status: 400 });

  const validated = validateScanTargetInput((body as { manifest?: unknown }).manifest);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  await saveScanTarget(workspaceId, platform, validated.manifest, user.id);
  trackEvent("platform.target_onboarded", user.id, user.role, {
    platform,
    has_static: !!validated.manifest.static,
    has_api: !!validated.manifest.apiEndpoints?.length,
  });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.target_onboarded",
    resourceType: "scan_target",
    resourceId: platform,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform, baseUrl: validated.manifest.baseUrl },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, platform, manifest: validated.manifest }, { status: 201 });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";
  const platform = new URL(req.url).searchParams.get("platform") ?? "";
  if (!platform) return NextResponse.json({ error: "platform_required" }, { status: 400 });

  const removed = await removeScanTarget(workspaceId, platform);
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  trackEvent("platform.target_offboarded", user.id, user.role, { platform });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.target_offboarded",
    resourceType: "scan_target",
    resourceId: platform,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, platform });
}
