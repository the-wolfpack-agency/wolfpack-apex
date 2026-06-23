/**
 * GET /api/admin/agents/[id]/drift: read an agent's drift history (OGIAM drift
 * detection).
 *
 * Returns the captured baseline (if any), the recorded drift events, and the
 * most recent event for convenience. This is the human view an admin uses to
 * understand how an agent's behavior has shifted over time and whether it has
 * been auto-paused.
 *
 * Capability: settings.manage_team (same gate as the rest of the agent admin
 * surface). Workspace-scoped: every read is scoped to the caller's workspace.
 * Read-only, so no audit entry. A null baseline + empty events is an explicit
 * empty state, never a blank page.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getBaseline, listDriftEvents } from "@/lib/agents/drift/store";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";

  const [baseline, events] = await Promise.all([
    getBaseline(agentId, workspaceId),
    listDriftEvents(agentId, workspaceId),
  ]);

  return NextResponse.json({
    baseline,
    events,
    latest: events[0] ?? null,
  });
}
