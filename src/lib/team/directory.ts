/**
 * Who has access to this workspace.
 *
 * `instinct_team_members` is the register of accounts, and `instinct_invites`
 * the register of offers not yet taken up. Together they answer "who can sign
 * in", which is a different question from "who works here" (`apex_employees`,
 * see src/lib/people.ts) and was previously only reachable through
 * /api/admin/team-status.
 *
 * It lives here because two surfaces now need it: the CTO's team-status view
 * and the HR roster. The queries are identical, and a second hand-written copy
 * of "who has access" is the kind of duplication that drifts into two different
 * answers to the same question.
 *
 * Both reads are scoped to one workspace. These are identity tables, so the
 * tenant guardrail permits an unscoped lookup when resolving a single principal
 * before the caller's workspace is known (`principal-resolve`). Enumerating
 * them is the opposite case: the caller's workspace IS known, and listing
 * without the predicate would hand one tenant another tenant's roster.
 */
import { safeQuery } from "@/lib/db";

export interface TeamMemberRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login: string | null;
  has_password: boolean;
  m365_connected: boolean;
}

export interface PendingInviteRow {
  id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: string;
  expires_at: string | null;
}

export interface DirectoryRead<T> {
  rows: T[];
  /** True when the DB was unreachable and this is stale/empty fallback data. */
  degraded: boolean;
}

/**
 * Every account in the workspace, active and revoked alike.
 *
 * Revoked members are deliberately included: the roster has to be able to show
 * that someone's access was removed, and to offer it back. Filtering them out
 * here is what makes a person vanish from the UI entirely, which reads as
 * "never existed" rather than "no longer has access".
 */
export async function listTeamMembers(workspaceId: string): Promise<DirectoryRead<TeamMemberRow>> {
  /* The m365 subquery joins on email rather than id because instinct_ms_tokens
     keys by user_email (migration 006, per-user tokens). A member is "connected"
     when a token row exists with an expiry, which proves they completed the
     OAuth flow. */
  const res = await safeQuery<TeamMemberRow>(
    `SELECT m.id, m.email, m.name, m.role, m.is_active,
            m.created_at::text AS created_at,
            m.last_login::text AS last_login,
            (m.password_hash IS NOT NULL AND LENGTH(m.password_hash) > 0) AS has_password,
            EXISTS (
              SELECT 1 FROM instinct_ms_tokens t
              WHERE LOWER(t.user_email) = LOWER(m.email)
                AND t.expires_at IS NOT NULL
            ) AS m365_connected
     FROM instinct_team_members m
     WHERE m.workspace_id = $1
     ORDER BY COALESCE(m.last_login, m.created_at) DESC`,
    [workspaceId],
  );
  return { rows: res.rows, degraded: Boolean(res.fromCache) && Boolean(process.env.DATABASE_URL) };
}

/**
 * Invites sent and not yet accepted, for this workspace.
 *
 * Callers are expected to drop invites whose email already has a member row:
 * someone can be invited and then sign in through Microsoft OAuth without ever
 * opening the link, which leaves a pending invite behind that no longer means
 * anything. `pendingInvitesFor` below does that filtering.
 */
export async function listPendingInvites(workspaceId: string): Promise<DirectoryRead<PendingInviteRow>> {
  const res = await safeQuery<PendingInviteRow>(
    `SELECT id, email, role, invited_by,
            created_at::text AS created_at, expires_at::text AS expires_at
     FROM instinct_invites
     WHERE status = 'pending' AND workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return { rows: res.rows, degraded: Boolean(res.fromCache) && Boolean(process.env.DATABASE_URL) };
}

/**
 * The invites that still represent someone who cannot yet sign in.
 *
 * Pure, so the rule is testable without a database.
 */
export function pendingInvitesFor(
  invites: readonly PendingInviteRow[],
  members: readonly TeamMemberRow[],
): PendingInviteRow[] {
  const claimed = new Set(members.map((m) => m.email.toLowerCase()));
  return invites.filter((i) => !claimed.has(i.email.toLowerCase()));
}
