/**
 * GET /api/admin/effectiveness - the "prove it works" rollup for the caller's
 * workspace: Secure Agent (changes governed / blocked / sent to human / risks
 * caught), Forcefield (decoys active / trips / agents contained), per-action
 * governance (every gate decision: allow / deny / transform / escalate /
 * would-block / agents active), and COGS (month-to-date AI spend), aggregated
 * from the authoritative records. Read-only. Capability: settings.manage_team.
 *
 * Returns: 200 { report } | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { computeEffectiveness, liveEffectivenessDeps } from "@/lib/effectiveness/rollup";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const report = await computeEffectiveness(auth.user.workspaceId ?? "default", liveEffectivenessDeps());
  return NextResponse.json({ report });
}
