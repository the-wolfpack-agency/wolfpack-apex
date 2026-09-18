/**
 * GET /api/admin/operators - the operators board: stored agent sightings grouped
 * into per-operator dossiers over a window. Read-only. Capability:
 * settings.manage_team. Returns 200 { operators } | 401/403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getOperators } from "@/lib/agent-operators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const daysRaw = Number(new URL(req.url).searchParams.get("days") ?? "30");
  const operators = await getOperators(auth.user.workspaceId ?? "default", Number.isFinite(daysRaw) ? daysRaw : 30);
  return NextResponse.json({ operators });
}
