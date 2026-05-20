/**
 * /api/admin/team-member-lookup — CTO/CEO diagnostic for "why won't this
 * teammate's login work".
 *
 * Returns the public-safe shape of an instinct_team_members row + the
 * matching instinct_invites row (if any) for a given email. NEVER
 * returns the password hash itself — only its length and bcrypt-prefix
 * so the caller can confirm a real hash exists without leaking the
 * value (length 60 + "$2[abxy]$" prefix = healthy bcrypt).
 *
 * Built 2026-05-20 after the gmail-invite incident: the user's accept
 * flow returned 200 but no team_member row was written (silent
 * writeQuery failure in the original safeQuery-based path). With this
 * endpoint, the CTO can see in one round-trip whether the row exists,
 * what case the stored email has, and whether is_active is true.
 *
 * Capability gate: `settings.manage_team` — same gate as /api/team/invite.
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
  workspace_id: string | null;
  created_at: string;
  password_hash: string | null;
}

interface InviteRow {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string;
  workspace_id: string | null;
  created_at: string;
  accepted_at: string | null;
  expires_at: string | null;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const rawEmail = url.searchParams.get("email") ?? "";
  if (!rawEmail || !rawEmail.includes("@")) {
    return NextResponse.json(
      { error: "?email=<address> required" },
      { status: 400 },
    );
  }
  const lookupEmail = rawEmail.trim().toLowerCase();

  const memberRes = await safeQuery<MemberRow>(
    `SELECT id, email, name, role, is_active, workspace_id, created_at, password_hash
     FROM instinct_team_members
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [lookupEmail],
  );

  const inviteRes = await safeQuery<InviteRow>(
    `SELECT id, email, role, status, invited_by, workspace_id, created_at, accepted_at, expires_at
     FROM instinct_invites
     WHERE LOWER(email) = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [lookupEmail],
  );

  if (memberRes.fromCache && process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database temporarily unavailable.", looked_up_as: lookupEmail },
      { status: 503 },
    );
  }

  const member = memberRes.rows[0];
  const memberDiag = member
    ? {
        exists: true,
        id: member.id,
        stored_email: member.email,
        stored_email_matches_lookup_case: member.email === lookupEmail,
        name: member.name,
        role: member.role,
        is_active: member.is_active,
        workspace_id: member.workspace_id,
        created_at: member.created_at,
        password_hash: {
          present: typeof member.password_hash === "string" && member.password_hash.length > 0,
          length: member.password_hash?.length ?? 0,
          // Bcrypt healthy hashes are exactly 60 chars and start with
          // $2a$ / $2b$ / $2x$ / $2y$. If either is off, the row is
          // unreachable via password login regardless of what the
          // operator types.
          looks_like_bcrypt:
            typeof member.password_hash === "string" &&
            member.password_hash.length === 60 &&
            /^\$2[abxy]\$/.test(member.password_hash),
        },
      }
    : { exists: false };

  const invites = inviteRes.rows.map((inv) => ({
    id: inv.id,
    stored_email: inv.email,
    stored_email_matches_lookup_case: inv.email === lookupEmail,
    role: inv.role,
    status: inv.status,
    invited_by: inv.invited_by,
    workspace_id: inv.workspace_id,
    created_at: inv.created_at,
    accepted_at: inv.accepted_at,
    expires_at: inv.expires_at,
    /* Indicates whether an accepted invite has a corresponding team
       members row — the smoking gun for the silent-write-loss bug
       this endpoint was built to diagnose. */
    silently_lost_write: inv.status === "accepted" && !member,
  }));

  return NextResponse.json({
    looked_up_as: lookupEmail,
    member: memberDiag,
    invites,
    shadow_mode: !process.env.DATABASE_URL,
  });
}
