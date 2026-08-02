/**
 * Behaviour scores for the fleet.
 *
 * Read-only. The scores come from the behaviour eval that runs on every task
 * (see lib/agents/evals), which reads the executor's record rather than the
 * agent's account of itself, so nothing here can be influenced by an agent
 * describing its run differently.
 *
 * Same capability as the rest of the agent surface: whoever can see the fleet
 * can see how it has behaved. Splitting those apart would let someone manage
 * agents without being able to see what they did, which is the wrong way round.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getFleetBehavior } from "@/lib/agents/evals/behavior-summary";

export const runtime = "nodejs";

/** Clamped so a caller cannot ask for an unbounded scan of the event table. */
const MAX_DAYS = 180;
const DEFAULT_DAYS = 30;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const raw = Number(req.nextUrl.searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : DEFAULT_DAYS;

  const agents = await getFleetBehavior(days);
  return NextResponse.json({ days, agents }, { status: 200 });
}
