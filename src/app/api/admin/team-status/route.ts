/**
 * GET /api/admin/team-status — CTO/CEO live view of who's on the team,
 * who's accepted their invite, and who's actually signed in.
 *
 * Shipped 2026-05-20 for the kickoff so the CTO can watch members
 * stream in during the meeting without staring at the DB.
 *
 * Returns:
 *   members:  rows from instinct_team_members enriched with derived
 *             accepted + onboardedRecently + recentlyActive flags.
 *   pendingInvites:  invites with status='pending' and no matching
 *                    member row yet.
 *   summary:  totals.
 *
 * Capability: settings.manage_team.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";

interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login: string | null;
  has_password: boolean;
}

interface InviteRow {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string;
  created_at: string;
  expires_at: string | null;
}

const RECENT_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RECENTLY_ONBOARDED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const memberRes = await safeQuery<MemberRow>(
    `SELECT id, email, name, role, is_active, created_at::text AS created_at,
            last_login::text AS last_login,
            (password_hash IS NOT NULL AND LENGTH(password_hash) > 0) AS has_password
     FROM instinct_team_members
     ORDER BY COALESCE(last_login, created_at) DESC`,
  );

  const inviteRes = await safeQuery<InviteRow>(
    `SELECT id, email, role, status, invited_by,
            created_at::text AS created_at, expires_at::text AS expires_at
     FROM instinct_invites
     WHERE status = 'pending'
     ORDER BY created_at DESC`,
  );

  if (memberRes.fromCache && process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database temporarily unavailable." },
      { status: 503 },
    );
  }

  const now = Date.now();
  const memberEmails = new Set(memberRes.rows.map((m) => m.email.toLowerCase()));

  const members = memberRes.rows.map((m) => {
    const lastLoginMs = m.last_login ? Date.parse(m.last_login) : 0;
    const createdMs = Date.parse(m.created_at);
    return {
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      is_active: m.is_active,
      created_at: m.created_at,
      last_login: m.last_login,
      /* "Accepted" = has a working credential. Distinguishes a user
         who clicked the invite link from a half-provisioned row. */
      accepted: m.has_password || !!m.last_login,
      /* "Recently active" = signed in within the last 15 min. The
         meeting demo signal. */
      recently_active: lastLoginMs > 0 && now - lastLoginMs < RECENT_LOGIN_WINDOW_MS,
      /* "Newly onboarded" = created in the last 24 h. */
      newly_onboarded: now - createdMs < RECENTLY_ONBOARDED_WINDOW_MS,
    };
  });

  /* A pending invite that doesn't yet have a team_members row is the
     "sent, not accepted" state. Filter out invites for already-
     existing members (they signed in via MS OAuth without using the
     invite link). */
  const pendingInvites = inviteRes.rows
    .filter((i) => !memberEmails.has(i.email.toLowerCase()))
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      invited_by: i.invited_by,
      created_at: i.created_at,
      expires_at: i.expires_at,
      hours_pending: Math.round((now - Date.parse(i.created_at)) / (60 * 60 * 1000)),
    }));

  const summary = {
    total_members: members.length,
    accepted: members.filter((m) => m.accepted).length,
    recently_active: members.filter((m) => m.recently_active).length,
    newly_onboarded: members.filter((m) => m.newly_onboarded).length,
    pending_invites: pendingInvites.length,
  };

  return NextResponse.json({
    summary,
    members,
    pending_invites: pendingInvites,
    fetched_at: new Date().toISOString(),
  });
}
