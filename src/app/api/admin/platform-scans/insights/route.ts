/**
 * Server-side CROSS-SCAN INSIGHTS endpoint - the moat, exposed.
 *
 * The platform-scan family persists single-layer findings (frontend, backend, db,
 * security, ux, perf) across executions. This route is the only thing that reads
 * that WHOLE corpus and folds it into higher-order cross-scan Insights:
 * compound_risk, regression, systemic_pattern, coverage_blind_spot - correlations
 * across modalities AND across time that no single-layer scanner can produce.
 *
 *   POST  generate insights NOW: reads findings across platforms, runs the pure
 *         correlate engine, persists via the insights store (UPSERT by stable key),
 *         fires platform.cross_scan_insight_generated per insight (+ the typed
 *         correlation/regression sub-events), audits the run, returns the insights.
 *
 *   GET   returns the recent insights for the dashboard feed.
 *
 * Dual auth mirrors the sibling benchmark route: CI bearer CRON_SECRET OR the
 * settings.manage_team capability (the SAME capability the other platform-scans
 * admin routes use - no new capability). Graceful-degrade idiom mirrored too:
 * generateInsights swallows a persistence failure and still returns the computed
 * insights + fires the learning events, so the route stays 200.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { generateInsights } from "@/lib/platform-scan/insights/generate";
import { listRecentInsights } from "@/lib/platform-scan/insights/insights-store";

/** CI path: Authorization: Bearer ${CRON_SECRET}. False when CRON_SECRET unset. */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Resolve actor identity from whichever auth path succeeds (mirrors benchmark).
  let workspaceId = "default";
  let actorId = "cross-scan-engine";
  let actorRole = "agent";

  if (isAuthorizedCron(req)) {
    // CI path: anonymous agent correlating the default workspace's findings.
  } else {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    workspaceId = auth.user.workspaceId ?? "default";
    actorId = auth.user.id;
    actorRole = auth.user.role;
  }

  // Correlate the full open corpus into cross-scan insights, persist, and fire the
  // learning events (one per insight + the typed sub-events). Never throws: a
  // store hiccup still returns the computed insights with the events already fired.
  const { insights, persisted } = await generateInsights(workspaceId, {
    id: actorId,
    role: actorRole,
  });

  // Audit the generation run (hash-chained, immutable): correlating the corpus is
  // a security-relevant agent action. Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: actorId, role: actorRole },
    action: "platform.cross_scan_insights_generated",
    resourceType: "platform_cross_scan_insights",
    resourceId: workspaceId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: {
      insight_count: insights.length,
      persisted,
      compound_risk: insights.filter((i) => i.kind === "compound_risk").length,
      regression: insights.filter((i) => i.kind === "regression").length,
      systemic_pattern: insights.filter((i) => i.kind === "systemic_pattern").length,
      coverage_blind_spot: insights.filter((i) => i.kind === "coverage_blind_spot").length,
    },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, persisted, insights });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  const insights = await listRecentInsights(limit);
  return NextResponse.json({ ok: true, insights });
}
