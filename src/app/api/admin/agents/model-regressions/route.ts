/**
 * GET /api/admin/agents/model-regressions
 *
 * Fleet-wide model-version regression view for the agents ops surface. Returns:
 *   - standings: the current live model-eval verdict for every active agent with
 *     enough data (newest model vs the model it used before), worst first.
 *   - regressions: the recent persisted regression/improvement ledger events.
 *
 * Read-only: the standings are computed on the fly and the ledger is written by
 * the cron sweep (GET /api/cron/agent-model-eval), so this route mutates nothing
 * and needs no audit entry of its own. Capability-gated on settings.manage_team,
 * the same gate that governs the rest of the agent admin surface. Workspace
 * scoped: both reads filter by the caller's workspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  getFleetModelStandings,
  listModelRegressions,
} from "@/lib/agents/evals/store";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspace = auth.user.workspaceId ?? "default";

  // Never 500 on a recoverable read error: an empty fleet view is honest and
  // keeps the surrounding agents page from blanking.
  try {
    const [standings, regressions] = await Promise.all([
      getFleetModelStandings(workspace),
      listModelRegressions(workspace, 20),
    ]);
    return NextResponse.json({ ok: true, standings, regressions }, { status: 200 });
  } catch (err) {
    console.error("[api/admin/agents/model-regressions]", (err as Error).message);
    return NextResponse.json(
      { ok: true, standings: [], regressions: [] },
      { status: 200 },
    );
  }
}
