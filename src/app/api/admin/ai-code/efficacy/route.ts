/**
 * GET /api/admin/ai-code/efficacy - is the factory getting better over time?
 *
 * Read-only loop-efficacy metrics (first-pass ready-rate, acceptance, duplication,
 * reuse-brain usage, repeat-finding rate + a recent-vs-prior trend) for the
 * /admin/ai-code "Improving over time" panel. Optional ?days=N (2..365, default 30).
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. Never throws
 * (loadLoopEfficacy degrades to zeros).
 *
 * Returns: 200 { efficacy } | 401/403 (auth/entitlement)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { loadLoopEfficacy } from "@/lib/ai-code/loop-efficacy";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const daysRaw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;
  const efficacy = await loadLoopEfficacy(resolveWorkspace(auth.user.workspaceId), days);
  return NextResponse.json({ efficacy }, { status: 200 });
}
