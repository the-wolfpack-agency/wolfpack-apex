/**
 * GET /api/admin/ai-code/task-grades - per-(model, task-type) first-pass ready
 * rate, so an operator sees which model ships best for which kind of task
 * (migration / UI / API / test / refactor / docs). Read-only, ?days=N (default 30).
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. Never throws.
 * Returns: 200 { grades } | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { loadTaskTypeGrades } from "@/lib/ai-code/task-type";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;
  const daysRaw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;
  const grades = await loadTaskTypeGrades(resolveWorkspace(auth.user.workspaceId), days);
  return NextResponse.json({ grades }, { status: 200 });
}
