/**
 * GET /api/forcefield-web/protection - the watch-and-report rollup for the
 * caller's workspace: how the site's agent traffic was handled (welcomed /
 * allowed / reported / blocked / decoy trips), from the inspection event log.
 * Read-only. Capability: settings.manage_team.
 *
 * Returns: 200 { report } | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { computeWebProtection, liveWebProtectionDeps } from "@/lib/forcefield-web/rollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const report = await computeWebProtection(auth.user.workspaceId ?? "default", liveWebProtectionDeps());
  return NextResponse.json({ report });
}
