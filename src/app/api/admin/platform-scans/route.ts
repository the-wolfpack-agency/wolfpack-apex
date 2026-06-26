import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { scanPlatform } from "@/lib/platform-scan/engine";
import { getScanManifest } from "@/lib/platform-scan/manifests";
import {
  recordScan,
  listFindings,
  type ScanFindingRow,
} from "@/lib/platform-scan/store";

/**
 * POST /api/admin/platform-scans -> run a black-box platform scan and persist
 * its findings. Gated on settings.manage_team (the same gate as the other
 * agent-admin routes). The manifest pins the target baseUrl + the route specs;
 * the engine never throws, so a hung/erroring target still yields findings.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  let body: { platform?: string };
  try {
    body = (await req.json()) as { platform?: string };
  } catch {
    body = {};
  }
  const platform = body.platform ?? "wolfpack-auto";

  const manifest = getScanManifest(platform);
  if (!manifest) {
    return NextResponse.json({ error: "unknown_platform" }, { status: 404 });
  }

  trackEvent("platform.scan_started", user.id, user.role, {
    platform,
    route_count: manifest.routes.length,
  });

  const result = await scanPlatform({
    workspaceId,
    platform,
    baseUrl: manifest.baseUrl,
    routes: manifest.routes,
  });

  const { scanId, findingCount, criticalCount } = await recordScan({
    workspaceId,
    actorId: user.id,
    actorRole: user.role,
    result,
  });

  // Audit the scan run: an agent action against an external platform is a
  // security-relevant event (hash-chained, immutable). Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.scan_run",
    resourceType: "platform_scan",
    resourceId: scanId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform, finding_count: findingCount, critical_count: criticalCount },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({
    ok: true,
    scanId,
    findingCount,
    criticalCount,
    findings: result.findings,
  });
}

/**
 * GET /api/admin/platform-scans -> the workspace's scan findings. Optional
 * ?status and ?platform narrow the queue (used by the findings triage UI).
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const params = req.nextUrl.searchParams;
  const status =
    (params.get("status") as ScanFindingRow["status"] | null) ?? undefined;
  const platform = params.get("platform") ?? undefined;

  const findings = await listFindings(workspaceId, { status, platform });
  return NextResponse.json({ findings });
}
