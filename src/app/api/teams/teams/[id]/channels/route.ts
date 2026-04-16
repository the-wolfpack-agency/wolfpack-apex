/**
 * GET /api/teams/teams/[id]/channels — list channels for a cached team.
 *
 * `[id]` is the local UUID from `instinct_teams_teams.id`, not the
 * ms_team_id — routes use local ids throughout so callers never need to
 * know which ms_team_id the user has access to.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getCachedTeamById,
  listCachedChannels,
} from "@/lib/integrations/microsoft-channel-messages";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const teamId = ctx.params?.id;
  if (!teamId) {
    return NextResponse.json(
      { error: "invalid_input", detail: "missing_id" },
      { status: 400 },
    );
  }

  const team = await getCachedTeamById(user.id, teamId);
  if (!team) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const channels = await listCachedChannels(user.id, teamId);
  return NextResponse.json({ team, channels });
}
