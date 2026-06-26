import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { summarizeFindings, listScans } from "@/lib/platform-scan/store";

/**
 * GET /api/admin/platform-scans/summary -> rollup for the review dashboard:
 * counts of OPEN findings by severity + category (optionally narrowed by
 * ?platform) and the recent scan-run history. Gated on settings.manage_team,
 * the same gate as the other platform-scan admin routes.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const platform = req.nextUrl.searchParams.get("platform") ?? undefined;

  const [summary, scans] = await Promise.all([
    summarizeFindings(workspaceId, platform),
    listScans(workspaceId),
  ]);
  return NextResponse.json({ summary, scans });
}
