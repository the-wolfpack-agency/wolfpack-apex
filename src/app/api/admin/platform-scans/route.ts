import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { scanPlatform } from "@/lib/platform-scan/engine";
import { scanSource, defaultReadFile } from "@/lib/platform-scan/static/scan";
import { discoverRoutes, mergeManifest } from "@/lib/platform-scan/discover";
import { getScanManifest } from "@/lib/platform-scan/manifests";
import type { PlatformScanResult } from "@/lib/platform-scan/types";
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

  let body: { platform?: string; mode?: string };
  try {
    body = (await req.json()) as { platform?: string; mode?: string };
  } catch {
    body = {};
  }
  const platform = body.platform ?? "wolfpack-auto";
  const mode = body.mode === "static" ? "static" : "http";

  const manifest = getScanManifest(platform);
  if (!manifest) {
    return NextResponse.json({ error: "unknown_platform" }, { status: 404 });
  }
  if (mode === "static" && !manifest.static) {
    return NextResponse.json({ error: "no_static_target" }, { status: 400 });
  }

  let result: PlatformScanResult;
  if (mode === "static" && manifest.static) {
    // White-box source scan: read the target repo's files + run the bug detectors.
    trackEvent("platform.scan_started", user.id, user.role, {
      platform,
      mode,
      route_count: manifest.static.paths.length,
    });
    result = await scanSource({
      platform,
      owner: manifest.static.owner,
      repo: manifest.static.repo,
      ref: manifest.static.ref,
      paths: manifest.static.paths,
      readFile: defaultReadFile(manifest.static.owner, manifest.static.repo, manifest.static.ref),
    });
  } else {
    // Black-box HTTP crawl. Merge sitemap-discovered routes with the curated seed
    // so the scan covers the real surface, not just the hardcoded list.
    const discovered = await discoverRoutes(manifest.baseUrl);
    const routes = mergeManifest(manifest.routes, discovered);
    trackEvent("platform.scan_started", user.id, user.role, {
      platform,
      mode,
      route_count: routes.length,
      discovered_count: discovered.length,
    });
    result = await scanPlatform({ workspaceId, platform, baseUrl: manifest.baseUrl, routes });
  }

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
    platform,
    mode,
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
