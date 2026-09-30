/**
 * GET /api/admin/ai-code/backlog?days=30
 *
 * The automation backlog: where humans are still needed, derived from the
 * factory's terminal ci-fix outcomes. Autonomy rate + escalations ranked by class
 * (the thing to automate next) + recent concrete cases. Workspace-scoped read.
 *
 * Capability + secure_agent entitlement gated. Never 500s on an empty history.
 * Returns: 200 { backlog } | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { listCiFixOutcomes, summarizeAutomationBacklog } from "@/lib/ai-code/backlog";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const daysParam = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 30;

  const outcomes = await listCiFixOutcomes(auth.user.workspaceId, days);
  const backlog = summarizeAutomationBacklog(outcomes);
  return NextResponse.json({ backlog });
}
