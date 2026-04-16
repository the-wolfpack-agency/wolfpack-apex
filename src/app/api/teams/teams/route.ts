/**
 * GET /api/teams/teams — list caller's cached Teams (joinedTeams).
 *
 * Cache-backed read path; never hits Graph directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listCachedTeams } from "@/lib/integrations/microsoft-channel-messages";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const teams = await listCachedTeams(user.id);
  return NextResponse.json({ teams });
}
