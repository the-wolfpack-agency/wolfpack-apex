/**
 * Spec-diff API: compare a prototype against an implementation, numerically.
 *
 *   POST /api/admin/spec-diff -> 200 { runId, summary, results } | 400 | 401 | 403 | 502
 *   GET  /api/admin/spec-diff -> 200 { runs } | 401 | 403
 *
 * Both URLs are operator-supplied, so both go through the SAME SSRF guard the
 * platform scanner uses: without it this endpoint is a request forwarder into
 * the private network. The comparison itself runs read-only.
 *
 * Auth is the shared requireCapability chokepoint, and every run is scoped to
 * the caller's workspace, audited, and recorded to analytics so conversion
 * quality becomes data rather than a screenshot in a chat thread.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { assertScannableUrl, SsrfBlockedError } from "@/lib/platform-scan/ssrf-guard";
import { runSpecDiff, type Viewport } from "@/lib/spec-diff/run";
import { saveSpecDiffRun, listSpecDiffRuns } from "@/lib/spec-diff/store";
import { DEFAULT_TOLERANCE_PX } from "@/lib/spec-diff/compare";
import { createSpecDiffBrowser } from "@/lib/spec-diff/browser";

export const dynamic = "force-dynamic";
/** A multi-viewport comparison drives a real browser; it needs more than the default. */
export const maxDuration = 300;

/** Defaults cover a laptop, a small laptop and a phone. */
const DEFAULT_VIEWPORTS: Viewport[] = [
  { width: 1512, height: 950 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const MAX_VIEWPORTS = 6;

function parseViewports(input: unknown): Viewport[] | null {
  if (input == null) return DEFAULT_VIEWPORTS;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_VIEWPORTS) return null;
  const out: Viewport[] = [];
  for (const v of input) {
    const width = Number((v as Viewport)?.width);
    const height = Number((v as Viewport)?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < 320 || width > 3840 || height < 400 || height > 2400) return null;
    out.push({ width: Math.round(width), height: Math.round(height) });
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  try {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 25);
    const runs = await listSpecDiffRuns(workspaceId, Number.isFinite(limit) ? limit : 25);
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const body = (await req.json().catch(() => null)) as
    | { specUrl?: string; targetUrl?: string; viewports?: unknown; tolerancePx?: number }
    | null;
  const specUrl = String(body?.specUrl ?? "").trim();
  const targetUrl = String(body?.targetUrl ?? "").trim();
  if (!specUrl || !targetUrl) {
    return NextResponse.json({ ok: false, error: "specUrl and targetUrl are required" }, { status: 400 });
  }

  const viewports = parseViewports(body?.viewports);
  if (!viewports) {
    return NextResponse.json({ ok: false, error: `viewports must be 1 to ${MAX_VIEWPORTS} sane {width,height} pairs` }, { status: 400 });
  }
  const tolerancePx = Number.isFinite(Number(body?.tolerancePx)) ? Math.abs(Number(body?.tolerancePx)) : DEFAULT_TOLERANCE_PX;

  // Operator-supplied URLs: refuse anything that could reach the private network.
  try {
    await assertScannableUrl(specUrl);
    await assertScannableUrl(targetUrl);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      trackEvent("spec_diff.blocked_url", user.id, user.role, { reason: err.message });
      return NextResponse.json({ ok: false, error: `blocked url: ${err.message}` }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "invalid url" }, { status: 400 });
  }

  const meta = extractRequestMetadata(req);
  const startedAt = Date.now();
  trackEvent("spec_diff.started", user.id, user.role, { spec_url: specUrl, target_url: targetUrl, viewport_count: viewports.length });

  let browser;
  try {
    browser = await createSpecDiffBrowser();
  } catch {
    return NextResponse.json({ ok: false, error: "browser_unavailable" }, { status: 502 });
  }

  try {
    const run = await runSpecDiff({ specUrl, targetUrl, viewports, tolerancePx, ...browser.hooks }, browser.browser);
    const durationMs = Date.now() - startedAt;
    const runId = await saveSpecDiffRun(workspaceId, run, { viewports, durationMs, createdBy: user.id });

    trackEvent("spec_diff.completed", user.id, user.role, {
      run_id: runId,
      clean: run.summary.clean,
      total_diffs: run.summary.totalDiffs,
      font_mismatch: run.summary.fontMismatch,
      duration_ms: durationMs,
    });
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "spec_diff.run",
      resourceType: "spec_diff",
      resourceId: runId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      afterState: { specUrl, targetUrl, clean: run.summary.clean, totalDiffs: run.summary.totalDiffs },
    });

    return NextResponse.json({ runId, summary: run.summary, results: run.results, errors: run.errors, durationMs });
  } catch (err) {
    trackEvent("spec_diff.failed", user.id, user.role, { message: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ ok: false, error: "spec_diff_failed" }, { status: 502 });
  } finally {
    await browser.close().catch(() => {});
  }
}
