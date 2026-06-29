/**
 * GET /api/admin/ai-surfaces — the AI Surface Inventory for the workspace.
 *
 * Returns every discovered AI touchpoint plus a summary (total + the "ungoverned
 * AI" gap + breakdowns). Read-only. Capability: settings.manage_team.
 *
 *   ?target=<id>        narrow to one scanned target
 *   ?ungoverned=true    only the ungoverned gap
 *
 * Returns: 200 { surfaces, summary } | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { listSurfaces, summarize } from "@/lib/ai-surface/store";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const target = url.searchParams.get("target") ?? undefined;
  const ungovernedOnly = url.searchParams.get("ungoverned") === "true";

  const workspaceId = auth.user.workspaceId ?? "default";
  const surfaces = await listSurfaces(workspaceId, { target, ungovernedOnly });
  const summary = summarize(surfaces);

  trackEvent("ai_inventory.viewed", auth.user.id, auth.user.role, {
    total: summary.total,
    ungoverned: summary.ungoverned,
  });

  return NextResponse.json({ surfaces, summary });
}
