/**
 * GET /api/ms/teams/[teamId]/channels — list channels in a team.
 *
 * Same auth + proxy pattern as /api/ms/teams.
 *
 * Responses:
 *   200 { channels: TeamChannel[] }
 *   200 { channels: [], scope_missing: true }     — needs Channel.ReadBasic.All
 *   200 { channels: [], connected: false }
 *   400 { error: "missing teamId" }
 *   401 { error: "Unauthorized" }
 *   500 { error: "Internal error" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { listTeamChannels } from "@/lib/ms-graph-teams";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { teamId } = await params;
  if (!teamId) {
    return NextResponse.json({ error: "missing teamId" }, { status: 400 });
  }
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw
      ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 50))
      : 50;
    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ channels: [], connected: false });
    }
    const result = await listTeamChannels(
      token.accessToken,
      teamId,
      limit,
      user.id,
    );
    if (!result.ok) {
      return NextResponse.json({ channels: [], scope_missing: true });
    }
    return NextResponse.json({ channels: result.channels });
  } catch (err) {
    console.error("[api/ms/teams/[teamId]/channels] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
