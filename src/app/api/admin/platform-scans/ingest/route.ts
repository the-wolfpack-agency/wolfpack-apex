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
import { classifyPage, type PageObservation } from "@/lib/platform-scan/browser/classify";
import { classifyJourney, type JourneyTrace } from "@/lib/platform-scan/browser/journey";
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
  /**
   * Optional RAW page observations. When present, apex classifies them
   * SERVER-SIDE via classifyPage so the UX detectors live and improve centrally
   * here and the external browser-scan runner can stay dumb (it ships raw signals
   * rather than pre-classified findings). The classified findings flow through the
   * SAME recordScan path as directly-supplied findings[] - no data lost.
   */
  observations?: unknown;
  /**
   * Optional tier-2 JOURNEY TRACES. Each trace is one full agent attempt at a
   * goal (the ordered gated actions). When present, apex runs classifyJourney
   * SERVER-SIDE (pure) and the friction findings flow through the SAME recordScan
   * path as findings[]/observations[]. Additive: absent, behavior is unchanged.
   * This is the ingest side of the openclaw driver contract (see browser/journey.ts).
   */
  traces?: unknown;
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
  // Either source may drive the scan; at least one must be present.
  const directFindings = Array.isArray(body.findings)
    ? (body.findings as ScanFinding[])
    : null;
  const observations = Array.isArray(body.observations)
    ? (body.observations as PageObservation[])
    : null;
  const traces = Array.isArray(body.traces)
    ? (body.traces as JourneyTrace[])
    : null;
  if (!platform || !baseUrl || (!directFindings && !observations && !traces)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "platform, baseUrl and at least one of findings[], observations[] or traces[] are required",
      },
      { status: 400 },
    );
  }

  // Classify any raw observations and journey traces SERVER-SIDE (classifyPage
  // and classifyJourney are pure), then merge with directly-supplied findings.
  // All sources feed the SAME scan so they flow through the identical recordScan
  // path (dedup, auto-resolve, Brain, analytics) - no data lost.
  const classifiedFindings = (observations ?? []).flatMap((obs) => classifyPage(obs));
  const journeyFindings = (traces ?? []).flatMap((trace) => classifyJourney(trace));
  const typedFindings: ScanFinding[] = [
    ...(directFindings ?? []),
    ...classifiedFindings,
    ...journeyFindings,
  ];

  // routeCount defaults to the count of probed units when observations and/or
  // traces drive the request (each is one route/journey the runner covered);
  // otherwise it falls back to the merged finding count (today's behavior for a
  // findings[]-only request). Explicit body.routeCount always wins.
  const probedUnits = (observations?.length ?? 0) + (traces?.length ?? 0);
  const routeCount =
    typeof body.routeCount === "number"
      ? body.routeCount
      : probedUnits > 0
        ? probedUnits
        : typedFindings.length;

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
