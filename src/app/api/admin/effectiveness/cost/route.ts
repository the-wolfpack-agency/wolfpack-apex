/**
 * GET /api/admin/effectiveness/cost?days=30 - per-tenant AI cost + usage for the
 * caller's workspace (the managed-LLM COGS view): total spend, calls, tokens,
 * and a per-model breakdown over the window. Read-only. Capability:
 * settings.manage_team.
 *
 * Returns: 200 { report } | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { computeCostUsage, liveCostDeps } from "@/lib/effectiveness/cost";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  // Absent param -> default; present-but-out-of-range -> clamped. (Number(null)
  // is 0, so we must distinguish "not provided" from a real 0.)
  const rawParam = req.nextUrl.searchParams.get("days");
  const parsed = rawParam === null ? NaN : Number(rawParam);
  const days = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_DAYS) : DEFAULT_DAYS;
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const report = await computeCostUsage(auth.user.workspaceId ?? "default", sinceIso, liveCostDeps());
  return NextResponse.json({ report, windowDays: days });
}
