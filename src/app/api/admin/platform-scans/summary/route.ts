import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { summarizeFindings, listScans, listFindings } from "@/lib/platform-scan/store";
import { scoreUxPosture } from "@/lib/platform-scan/ux-posture";
import { trackEvent } from "@/lib/analytics";
import type { ScanFinding } from "@/lib/platform-scan/types";

/**
 * GET /api/admin/platform-scans/summary -> rollup for the review dashboard:
 * counts of OPEN findings by severity + category (optionally narrowed by
 * ?platform), the recent scan-run history, AND the UX/accessibility posture grade
 * (uxPosture) - an at-a-glance usability/a11y health that trends over time,
 * mirroring the security posture grade. Gated on settings.manage_team, the same
 * gate as the other platform-scan admin routes.
 *
 * The response shape is ADDITIVE: uxPosture sits alongside the existing
 * { summary, scans } so older clients keep working.
 *
 * Learning tie-in: every read of the grade fires platform.ux_posture_scored so
 * the grade is trended in the analytics/learning loop, not just rendered once.
 * No data lost: the score is derived from the SAME open ux_gap findings the
 * scanner persisted - a faithful synthesis, never a separate source of truth.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const platform = req.nextUrl.searchParams.get("platform") ?? undefined;

  const [summary, scans, openFindings] = await Promise.all([
    summarizeFindings(workspaceId, platform),
    listScans(workspaceId),
    // Score over the workspace's OPEN findings. scoreUxPosture keeps only the
    // ux_gap category, so passing the full open set is correct (and one query).
    listFindings(workspaceId, { status: "open", platform, limit: 500 }),
  ]);

  // ScanFindingRow is a superset of ScanFinding (extra row metadata); the scorer
  // reads only category/severity/title, so the rows satisfy the scorer's input.
  const uxPosture = scoreUxPosture(openFindings as unknown as ScanFinding[]);

  // Trend the grade in the learning loop. metadata is scalar-only; the grade,
  // counts, and platform are exactly what the event documents.
  trackEvent("platform.ux_posture_scored", auth.user.id, auth.user.role, {
    platform: platform ?? "all",
    grade: uxPosture.grade,
    ux: uxPosture.ux,
    a11y: uxPosture.a11y,
    total: uxPosture.total,
  });

  return NextResponse.json({ summary, scans, uxPosture });
}
