/**
 * POST /api/admin/platform-scans/ingest/sarif: tool-agnostic SARIF ingest.
 *
 * Any SAST tool that emits SARIF 2.1.0 (Semgrep, gitleaks, CodeQL, Trivy) posts
 * its report here. We parse the standard once (parseSarif) into the SAME
 * ScanFinding the HTTP probe + browser runner emit, then hand it to the shared
 * recordScan store so external scanner output lands in the identical pipeline:
 * dedup, auto-resolve on re-scan, Brain ingest, analytics, audit. There is no
 * parallel persistence here: the store owns the learning tie-in.
 *
 * Auth mirrors the sibling ingest route exactly:
 *   1. CI path: Authorization: Bearer ${CRON_SECRET} (false when unset).
 *   2. User path: requireCapability(req, "settings.manage_team").
 *
 * Never 500s on a recoverable condition: invalid JSON / missing platform / a
 * non-object sarif are 400s; a store hiccup past validation returns a zeroed
 * 200 (skipped:true) so a CI post never loses the run to a transient failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { recordScan } from "@/lib/platform-scan/store";
import { parseSarif } from "@/lib/platform-scan/sarif";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

interface SarifIngestBody {
  platform?: unknown;
  sarif?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds.
  let workspaceId = "default";
  let actorId = "sast-scan";
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

  let body: SarifIngestBody;
  try {
    body = (await req.json()) as SarifIngestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!platform) {
    return NextResponse.json({ ok: false, error: "platform_required" }, { status: 400 });
  }
  if (typeof body.sarif !== "object" || body.sarif === null) {
    return NextResponse.json({ ok: false, error: "sarif_required" }, { status: 400 });
  }

  const result = parseSarif(body.sarif, platform);

  try {
    const { scanId, findingCount, criticalCount, autoResolvedCount } = await recordScan({
      workspaceId,
      actorId,
      actorRole,
      result,
    });
    // Audit the ingest (hash-chained, immutable): an external scanner landing
    // findings is a security-relevant agent action. Best effort.
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: actorId, role: actorRole },
      action: "platform.scan_ingest_sarif",
      resourceType: "platform_scan",
      resourceId: scanId ?? "unknown",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      afterState: { platform, finding_count: findingCount, critical_count: criticalCount },
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({
      ok: true,
      platform,
      scanId,
      findingCount,
      criticalCount,
      autoResolvedCount,
    });
  } catch (err) {
    console.error("[platform-scans/ingest/sarif]", (err as Error).message);
    // Zeroed 200 so the CI post step stays green and the run is not lost.
    return NextResponse.json({ ok: true, skipped: true, scanId: null, findingCount: 0 });
  }
}
