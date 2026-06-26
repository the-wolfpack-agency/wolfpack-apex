/**
 * POST /api/admin/platform-scans/ingest: ingest browser-journey findings.
 *
 * The browser layer of the platform-scan feature (a Playwright runner in CI)
 * loads a target platform's pages authenticated, classifies the live signals
 * into ScanFindings, and POSTs them here. This route is the seam between that
 * out-of-process runner and the shared findings store — the SAME store the
 * HTTP route probe writes to, so browser findings land in the same review UI.
 *
 * Two auth paths (mirrors /api/cron/integration-health):
 *   1. CI path: Authorization: Bearer ${CRON_SECRET}. The workflow hits this
 *      with the ingest secret. Returns false when CRON_SECRET is unset.
 *   2. User path: requireCapability(req, "settings.manage_team") for an admin
 *      ingesting a scan manually.
 *
 * Never 500s on a recoverable condition: a malformed body is a 400, a bad
 * payload that slips past validation returns a zeroed 200 so the CI runner's
 * post step stays green and the run is not lost to a transient store hiccup.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { recordScan } from "@/lib/platform-scan/store";
import type { PlatformScanResult, ScanFinding } from "@/lib/platform-scan/types";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

interface IngestBody {
  platform?: unknown;
  baseUrl?: unknown;
  routeCount?: unknown;
  findings?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds.
  let workspaceId = "default";
  let actorId = "browser-scan";
  let actorRole = "agent";

  if (isAuthorizedCron(req)) {
    // CI path: anonymous agent into the default workspace.
  } else {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    workspaceId = auth.user.workspaceId ?? "default";
    actorId = auth.user.id;
    actorRole = auth.user.role;
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const findings = body.findings;
  if (!platform || !baseUrl || !Array.isArray(findings)) {
    return NextResponse.json(
      { ok: false, error: "platform, baseUrl and findings[] are required" },
      { status: 400 },
    );
  }

  const typedFindings = findings as ScanFinding[];
  const routeCount =
    typeof body.routeCount === "number" ? body.routeCount : typedFindings.length;

  const result: PlatformScanResult = {
    platform,
    baseUrl,
    routeCount,
    okCount: 0,
    findings: typedFindings,
  };

  try {
    const { scanId, findingCount } = await recordScan({
      workspaceId,
      actorId,
      actorRole,
      result,
    });
    // Audit the ingest (hash-chained, immutable): a browser-runner scan landing
    // findings is a security-relevant agent action. Best effort.
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: actorId, role: actorRole },
      action: "platform.scan_ingested",
      resourceType: "platform_scan",
      resourceId: scanId ?? "unknown",
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
      afterState: { platform, finding_count: findingCount, source: "browser" },
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    return NextResponse.json({ ok: true, scanId, findingCount });
  } catch (err) {
    console.error("[platform-scans/ingest]", (err as Error).message);
    return NextResponse.json({ ok: true, scanId: null, findingCount: 0 });
  }
}
