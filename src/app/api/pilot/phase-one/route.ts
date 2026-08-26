/**
 * GET /api/pilot/phase-one — the figures behind the phase one dashboard.
 *
 * A route rather than a server component reading the database directly, and
 * the reason is not style. The direct version had no capability gate on it at
 * all and no workspace in scope, so it would have served a client-facing
 * summary to anybody who reached the URL and counted every tenant's connected
 * libraries while doing it. The repo-wide tenancy scan caught the second
 * problem, which is what surfaced the first.
 *
 * Gated on assistant.use because that is the capability that means "this
 * person may ask this product questions", and every figure here is a summary
 * of questions asked and answered.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getPhaseOneSnapshot } from "@/lib/pilot/phase-one";

const DEFAULT_DAYS = 60;
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "assistant.use");
  if (!auth.ok) return auth.response;

  const raw = Number(req.nextUrl.searchParams.get("days"));
  const days =
    Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : DEFAULT_DAYS;

  const workspaceId = auth.user.workspaceId ?? "default";
  const snapshot = await getPhaseOneSnapshot(workspaceId, days);

  return NextResponse.json(snapshot, {
    status: 200,
    /* Never cached: a dashboard figure that is minutes old invites somebody to
       act on a number that has already moved. */
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
