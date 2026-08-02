/**
 * The click-and-go compliance scan.
 *
 * POST runs one scan and returns the report. GET lists previous runs for a
 * target, so the page has history to show without running anything.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO
 *
 * It does not take a URL and scan it. The URL comes from the resolved target
 * manifest, and the target must be curated or ownership-verified — the same
 * floor the existing platform-scan route enforces, applied through the same
 * helpers. A tool that fetches any URL an authenticated user types and files a
 * report about it is a request-forgery surface with a friendly form on top.
 *
 * runSiteScan() asks the browser gate again internally (kill switch, ownership,
 * SSRF, OGIAM decision, audit). That is intentional overlap: this route's check
 * gives a clean 403 with a reason the UI can show, and the service's check means
 * no future caller can reach a client system by skipping this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { extractRequestMetadata, recordAudit } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { resolveScanTarget, isCuratedTarget } from "@/lib/platform-scan/manifests";
import { isTargetVerified } from "@/lib/platform-scan/authorization";
import { runSiteScan } from "@/lib/platform-scan/compliance/run";
import { listAnomalyRuns } from "@/lib/platform-scan/anomaly/store";

export const runtime = "nodejs";
/** A live site fetch plus parsing. Comfortably inside the default ceiling, but
 *  stated rather than inherited so a slow client site cannot be cut off mid-scan
 *  by a platform default changing underneath us. */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  let body: { platform?: unknown; path?: unknown };
  try {
    body = (await req.json()) as { platform?: unknown; path?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  // A path that is not a string is a malformed request, not a request for the
  // root. Guessing what a caller meant is how a bug in their code becomes a
  // scan of the wrong page that nobody notices.
  if (body.path !== undefined && typeof body.path !== "string") {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  if (!platform) return NextResponse.json({ error: "platform_required" }, { status: 400 });

  const manifest = await resolveScanTarget(workspaceId, platform);
  if (!manifest) return NextResponse.json({ error: "unknown_platform" }, { status: 404 });

  // Fail-closed ownership floor, identical to the platform-scan route: an
  // onboarded client target must be proven client-owned before we touch it.
  if (!isCuratedTarget(platform) && !(await isTargetVerified(workspaceId, platform))) {
    trackEvent("platform.scan_blocked_unverified", user.id, user.role, { platform, action: "compliance" });
    // try/catch rather than .catch(): a synchronous throw from the audit layer
    // would sail straight past a rejection handler and turn a clean 403 into a
    // 500. The refusal must survive a broken ledger.
    try {
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "platform.compliance_scan.blocked",
        resourceType: "platform_scan",
        resourceId: platform,
        afterState: { platform, reason: "target_not_verified" },
        ...extractRequestMetadata(req),
      });
    } catch {
      /* Best-effort: the decision is already made and tracked. */
    }
    return NextResponse.json({ error: "target_not_verified" }, { status: 403 });
  }

  // The path is ours to control, not the caller's: only a path under the
  // manifest's own base URL, so this cannot be steered at another host.
  let pageUrl: string;
  try {
    pageUrl = new URL(sanitizePath(body.path), manifest.baseUrl).toString();
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  const result = await runSiteScan({
    workspaceId,
    platform,
    pageUrl,
    actor: { userId: user.id, role: user.role },
  });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 403 });
  return NextResponse.json({ report: result.report }, { status: 200 });
}

/** Only a same-origin path. Anything that looks like a host or a scheme is
 *  reduced to "/" rather than rejected, so a stray value cannot redirect the
 *  scan somewhere else. */
function sanitizePath(raw: string | undefined): string {
  const p = (raw ?? "/").trim();
  if (!p.startsWith("/") || p.startsWith("//")) return "/";
  return p;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const platform = req.nextUrl.searchParams.get("platform")?.trim();
  if (!platform) return NextResponse.json({ error: "platform_required" }, { status: 400 });

  const runs = await listAnomalyRuns(workspaceId, platform, 20);
  return NextResponse.json({ runs }, { status: 200 });
}
