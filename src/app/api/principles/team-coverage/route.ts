/**
 * GET /api/principles/team-coverage
 *
 * Leadership-only. Returns "X of Y team members have connected
 * Microsoft" + the list of names that haven't, so the team scoreboard
 * can show who's missing from the per-member rows.
 *
 * The per-member validators (focus_block_ratio, meeting_density,
 * mail.after_hours_send, etc.) require a per-user M365 OAuth token in
 * `instinct_ms_tokens` to read each member's calendar / mail / tasks.
 * Without a token, the team scoreboard for that member is empty.
 * Surfacing the gap explicitly lets leadership chase down logins.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { safeQuery } from "@/lib/db";

interface TeamRow {
  id: string;
  email: string;
  name: string;
  connected: boolean;
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  /* Filter out demo accounts (@wolfpack.dev seed users from
     migration 001) — they're not real team members and shouldn't
     count toward coverage. Real team rows live under
     @thewolfpack.agency per migration 125. */
  const result = await safeQuery<{
    id: string;
    email: string;
    name: string;
    has_token: boolean;
  }>(
    `SELECT m.id, m.email, m.name,
            EXISTS (
              SELECT 1 FROM instinct_ms_tokens t
               WHERE t.connected_by = m.id
                  OR LOWER(t.user_email) = LOWER(m.email)
            ) AS has_token
       FROM instinct_team_members m
      WHERE m.is_active = TRUE
        AND LOWER(m.email) NOT LIKE '%@wolfpack.dev'
      ORDER BY m.name`,
    [],
  );

  const members: TeamRow[] = result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    connected: r.has_token === true,
  }));
  const connected = members.filter((m) => m.connected).length;
  const total = members.length;
  const unconnected = members.filter((m) => !m.connected);

  return NextResponse.json({
    connected,
    total,
    unconnected: unconnected.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name,
    })),
    members,
  });
}
