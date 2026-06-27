import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { runPreflight } from "@/lib/platform-scan/preflight";

/**
 * GET /api/admin/platform-scans/preflight?platform=<id> -> verify a target is
 * correctly configured and reachable BEFORE running a real engagement, so a
 * misconfiguration is caught by the operator, not in front of the client. All
 * checks are read-only and non-destructive. The run is audited and tracked so
 * onboarding friction (which checks fail, how often) feeds the learning loop.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const platform = req.nextUrl.searchParams.get("platform")?.trim();
  if (!platform) {
    return NextResponse.json({ error: "platform is required" }, { status: 400 });
  }

  const result = await runPreflight(workspaceId, platform);
  const failed = result.checks.filter((c) => !c.pass).map((c) => c.name);

  trackEvent("platform.preflight_run", user.id, user.role, {
    platform,
    ok: result.ok,
    checks: result.checks.length,
    failed: failed.join(",") || "none",
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.preflight_run",
    resourceType: "platform_scan",
    resourceId: platform,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { workspaceId, ok: result.ok, failed },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json(result);
}
