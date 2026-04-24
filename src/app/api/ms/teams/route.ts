/**
 * GET /api/ms/teams — list the signed-in user's joined Microsoft Teams.
 *
 * Server-side proxy so the MS access token never leaves the server.
 * Auth via the Instinct JWT, MS token resolved via getValidToken.
 *
 * Responses:
 *   200 { teams: JoinedTeam[] }                   — success
 *   200 { teams: [], scope_missing: true }        — needs Team.ReadBasic.All
 *   200 { teams: [], connected: false }           — user hasn't linked MS yet
 *   401 { error: "Unauthorized" }                 — no Instinct JWT
 *   500 { error: "Internal error" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { listJoinedTeams } from "@/lib/ms-graph-teams";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw
      ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 50))
      : 50;
    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ teams: [], connected: false });
    }
    const result = await listJoinedTeams(token.accessToken, limit, user.id);
    if (!result.ok) {
      if (result.code === "scope_missing") {
        return NextResponse.json({ teams: [], scope_missing: true });
      }
      // Real Graph error — surface so the UI shows "couldn't load"
      // rather than masquerading as "user has 0 teams". Keep status
      // 200 so the client doesn't treat this as an auth failure.
      return NextResponse.json({
        teams: [],
        graph_error: true,
        graph_status: result.status,
      });
    }
    return NextResponse.json({ teams: result.teams });
  } catch (err) {
    console.error("[api/ms/teams] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
