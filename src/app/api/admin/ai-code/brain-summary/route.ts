/**
 * GET /api/admin/ai-code/brain-summary - ONE headline view of every factory
 * learning signal (memory sizes, first-pass trend, gate precision, repair
 * resolve rate, model grades, human-edit rate), so an operator can see at a
 * glance whether the factory is improving over time. Read-only, ?days=N (30).
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. Never throws.
 * Returns: 200 { summary } | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { loadBrainSummary } from "@/lib/ai-code/factory-brain-summary";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;
  const daysRaw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;
  const summary = await loadBrainSummary(resolveWorkspace(auth.user.workspaceId), days);
  return NextResponse.json({ summary }, { status: 200 });
}
