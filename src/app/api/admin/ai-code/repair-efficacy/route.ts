/**
 * GET /api/admin/ai-code/repair-efficacy - how often Stage-2 auto-fix RESOLVED a
 * gate block without a human, per block category (security / invariant /
 * deep-scan). Read-only, ?days=N (default 30). Shows which blocks are reliably
 * auto-fixable so an operator can trust the repair path (and spot ones that
 * should escalate sooner).
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. Never throws.
 * Returns: 200 { efficacy } | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { loadRepairEfficacy } from "@/lib/ai-code/factory-repair-recipes";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;
  const daysRaw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;
  const efficacy = await loadRepairEfficacy(resolveWorkspace(auth.user.workspaceId), days);
  return NextResponse.json({ efficacy }, { status: 200 });
}
