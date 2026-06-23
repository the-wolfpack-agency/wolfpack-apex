/**
 * GET /api/admin/ogiam/decisions: CTO read surface over the OGIAM decision
 * ledger.
 *
 * OGIAM (the deterministic authorization layer for AI actions) runs in shadow
 * mode in Phase 0: it records what the gate WOULD have decided for every action
 * the assistant took, without blocking. This route exposes that evidence stream
 * to an admin: a small summary plus the most recent decisions.
 *
 * Query params:
 *   limit        : 1..500, default 100 (most recent first)
 *   would_block  : "1" to narrow to the rows enforcement would have stopped
 *   agent        : narrow to a single acting agent's gated actions
 *
 * Capability: settings.manage_team (same gate as /api/admin/feedback, the
 * people who manage the team are the people who should review what the
 * assistant has been authorized to do on their behalf).
 *
 * Workspace-scoped: only decisions from the caller's workspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listDecisions, summarizeDecisions } from "@/lib/ogiam/queries";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const wouldBlockOnly = url.searchParams.get("would_block") === "1";
  /* Optional single-agent filter: an agent profile passes ?agent=<id> to show
     only that agent's gated actions. Absent (or empty) means no filter. */
  const agentParam = url.searchParams.get("agent");
  const agentId = agentParam && agentParam.trim() ? agentParam.trim() : undefined;

  const workspaceId = auth.user.workspaceId ?? "default";

  const [summary, decisions] = await Promise.all([
    summarizeDecisions(workspaceId),
    listDecisions(workspaceId, { limit, wouldBlockOnly, agentId }),
  ]);

  /* listDecisions returns [] on both "no rows" and "db unavailable". We can't
     distinguish those from the rows alone, so re-derive the cache signal: if
     there is no DATABASE_URL configured the explorer cannot be served, surface
     503 rather than a misleading empty ledger. Mirrors the feedback route. */
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database temporarily unavailable." },
      { status: 503 },
    );
  }

  return NextResponse.json({
    workspace_id: workspaceId,
    summary,
    decisions,
  });
}
