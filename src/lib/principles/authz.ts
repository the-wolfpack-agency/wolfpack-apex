/**
 * Principles authorization — single source of truth for who can see
 * what evidence.
 *
 * Tier model:
 *   - Members (any role except ceo/cto): own observations only.
 *   - Leadership (ceo, cto): all observations (own + everyone else's).
 *
 * Member experience is intentionally absent of any "leadership has
 * visibility" indicator — per the agreed product framing, principles
 * are a self-improvement surface. Leadership visibility is an internal
 * dashboard, not a member-facing notification.
 *
 * Privacy guarantee is layered:
 *   1) canReadTeamEvidence() gate at every API route returning
 *      observations beyond the caller's own.
 *   2) DB query helper applyMemberScope() forces subject_user_id =
 *      callerId for non-leadership reads (defense in depth — even if
 *      a route forgets the gate, the query itself is scoped).
 *   3) Audit log writes whenever leadership opens cross-user evidence.
 *      Internal-only; never surfaced to the subject (per the
 *      "members don't need to know leadership knows" decision).
 */

import { writeQuery } from "@/lib/db";

export interface AuthorizedUser {
  id: string;
  role: string;
}

const LEADERSHIP_ROLES = new Set(["ceo", "cto", "evp"]);

export function canReadTeamEvidence(user: AuthorizedUser): boolean {
  return LEADERSHIP_ROLES.has((user.role || "").toLowerCase());
}

/**
 * Defense-in-depth query scope helper. Returns the SQL fragment + the
 * parameter the caller must inject into their query. Members get
 * `subject_user_id = $N`; leadership gets `TRUE` (no scope).
 *
 *   const scope = applyMemberScope(user, /* paramIndex *\/ 1);
 *   const sql = `SELECT ... FROM ... WHERE ${scope.where}`;
 *   await query(sql, [...scope.params]);
 *
 * Centralizing this means a route can never accidentally skip the
 * scope — the helper always returns a valid WHERE clause.
 */
export function applyMemberScope(
  user: AuthorizedUser,
  paramIndex: number,
): { where: string; params: string[] } {
  if (canReadTeamEvidence(user)) {
    return { where: "TRUE", params: [] };
  }
  return {
    where: `subject_user_id = $${paramIndex}`,
    params: [user.id],
  };
}

/**
 * Audit-log a leadership view of cross-user evidence. Writes are
 * fire-and-forget from the caller's perspective: a write failure
 * doesn't block the read (the read already happened by the time the
 * audit row gets written), but the failure is logged for ops review.
 *
 * Member self-views (subjectUserId === viewerUserId) are NOT audited
 * — there's nothing to audit. Same for non-leadership views (they
 * can't read anyone else's data anyway).
 */
export async function recordEvidenceView(args: {
  viewer: AuthorizedUser;
  subjectUserId: string | null;
  route: string;
  evidenceCount: number;
}): Promise<void> {
  if (!canReadTeamEvidence(args.viewer)) return;
  if (args.subjectUserId && args.subjectUserId === args.viewer.id) return;
  try {
    await writeQuery(
      `INSERT INTO instinct_principle_evidence_views
         (viewer_user_id, viewer_role, subject_user_id, route, evidence_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        args.viewer.id,
        args.viewer.role,
        args.subjectUserId,
        args.route,
        args.evidenceCount,
      ],
    );
  } catch (err) {
    console.error(
      "[principles/authz] recordEvidenceView failed:",
      (err as Error).message,
    );
  }
}
