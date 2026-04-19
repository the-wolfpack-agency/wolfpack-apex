/**
 * site-approvals.ts — orchestration over `apex_site_approvals`.
 *
 * Responsibilities:
 *   - Persist every client approval / "request changes" event as a
 *     load-bearing row (used downstream for AR + dispute avoidance).
 *   - Fire analytics on every transition so the learning loop sees
 *     which sites win approval fast, which get repeated change
 *     requests, which never get touched — and later, which comments
 *     correlate with eventual churn.
 *   - Provide `checkApprovalGate(siteId)` — the forward-compatible
 *     entry point that `triggerDeploy` will consult once the gate is
 *     switched on. CURRENTLY this function always returns
 *     `{ allowed: true }` — the tests lock that contract so the first
 *     day we flip it, we do so INTENTIONALLY.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type ApprovalState = "pending" | "approved" | "changes_requested";

export interface ApprovalRecord {
  id: string;
  siteId: string;
  state: ApprovalState;
  actorName: string | null;
  actorEmail: string | null;
  comment: string | null;
  createdAt: string;
  viaShareToken: boolean;
  /** The UUID in apex_share_tokens.id when this approval came from a
   * public /share link. null for authed-Instinct-user approvals. */
  shareTokenId: string | null;
}

function rowToRecord(row: Record<string, unknown>): ApprovalRecord {
  const shareTokenId = (row.share_token_id as string) || null;
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    state: row.state as ApprovalState,
    actorName: (row.actor_name as string) || null,
    actorEmail: (row.actor_email as string) || null,
    comment: (row.comment as string) || null,
    createdAt: row.created_at as string,
    viaShareToken: shareTokenId !== null,
    shareTokenId,
  };
}

export interface RecordApprovalOpts {
  siteId: string;
  state: "approved" | "changes_requested";
  actorName?: string;
  actorEmail?: string;
  comment?: string;
  /** UUID from apex_share_tokens — set when approval came via /share/[token]. */
  shareTokenRowId?: string;
  /** Present when an authed Instinct user recorded the approval directly.
   * Used purely for analytics attribution. */
  userId?: string;
  userRole?: string;
}

/**
 * Insert a new approval row + emit the analytics event.
 *
 * We DO NOT mutate prior rows — approvals are append-only. The
 * "current state" for a site is derived at read time from the newest
 * row (see `latestApprovalState`). That way the audit trail is
 * complete: we can always replay the full approval lifecycle.
 */
export async function recordApproval(
  opts: RecordApprovalOpts,
): Promise<ApprovalRecord> {
  const actorName = (opts.actorName ?? "").trim().slice(0, 200) || null;
  const actorEmail = (opts.actorEmail ?? "").trim().slice(0, 320) || null;
  const comment = (opts.comment ?? "").trim().slice(0, 4000) || null;

  const result = await safeQuery<Record<string, unknown>>(
    `INSERT INTO apex_site_approvals
       (site_id, share_token_id, state, actor_name, actor_email, comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      opts.siteId,
      opts.shareTokenRowId ?? null,
      opts.state,
      actorName,
      actorEmail,
      comment,
    ],
  );

  const viaShareToken = Boolean(opts.shareTokenRowId);
  const userId = opts.userId ?? "public";
  const userRole = opts.userRole ?? (viaShareToken ? "client" : "unknown");

  const eventType =
    opts.state === "approved" ? "site.approval_recorded" : "site.changes_requested";

  trackEvent(eventType, userId, userRole, {
    site_id: opts.siteId,
    state: opts.state,
    via_share_token: viaShareToken,
    has_comment: comment !== null,
    has_actor_email: actorEmail !== null,
  });

  if (result.rows.length === 0) {
    // Shadow-mode synthesis — the HTTP layer still needs a shape to
    // render, and the analytics event has already fired so we don't
    // lose the signal.
    return {
      id: `approval_shadow_${Date.now()}`,
      siteId: opts.siteId,
      state: opts.state,
      actorName,
      actorEmail,
      comment,
      createdAt: new Date().toISOString(),
      viaShareToken,
      shareTokenId: opts.shareTokenRowId ?? null,
    };
  }
  return rowToRecord(result.rows[0]);
}

/**
 * List every approval for a site, newest first. Returns the full
 * history — the UI shows the latest state prominently and the history
 * in a collapsed section.
 */
export async function listApprovalsForSite(
  siteId: string,
): Promise<ApprovalRecord[]> {
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT id, site_id, share_token_id, state, actor_name, actor_email,
            comment, created_at
       FROM apex_site_approvals
      WHERE site_id = $1
      ORDER BY created_at DESC`,
    [siteId],
  );
  return rows.map(rowToRecord);
}

/**
 * Return the newest approval row for a site, or null if the site has
 * no approvals yet. The UI treats null as "pending client review".
 */
export async function latestApprovalState(
  siteId: string,
): Promise<ApprovalRecord | null> {
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT id, site_id, share_token_id, state, actor_name, actor_email,
            comment, created_at
       FROM apex_site_approvals
      WHERE site_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [siteId],
  );
  if (rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

export interface ApprovalGateResult {
  allowed: boolean;
  reason?: string;
  /** Non-null when the gate consulted an existing approval row so
   * callers can surface "approved by <name> on <date>" in audit logs. */
  approval?: ApprovalRecord | null;
}

/**
 * Approval gate — consulted by `triggerDeploy` (future wave).
 *
 * RIGHT NOW this function always returns `{ allowed: true }`. That is
 * INTENTIONAL: we're shipping the approval data model + UI first so
 * approvals start accumulating. Turning the gate on before data exists
 * would block every deploy on day one.
 *
 * Once the env flag `INSTINCT_APPROVAL_GATE_ENABLED === "true"` is set
 * (future PR), this function will enforce approvals and block deploys
 * for sites with a non-approved latest state. Tests lock the CURRENT
 * behavior so we only flip it deliberately.
 *
 * @see `src/lib/sites.ts` `triggerDeploy` — add the gate call there.
 */
export async function checkApprovalGate(
  siteId: string,
): Promise<ApprovalGateResult> {
  // Feature-flagged gate. Currently OFF by design. When we flip the
  // flag, the branch below activates and the tests will need to
  // update — that's the signal to the next engineer that this is a
  // deliberate behavior change, not a drift.
  // eslint-disable-next-line no-constant-condition
  if (false /* process.env.INSTINCT_APPROVAL_GATE_ENABLED === "true" */) {
    const latest = await latestApprovalState(siteId);
    if (!latest || latest.state !== "approved") {
      return {
        allowed: false,
        reason: "no_client_approval_recorded",
        approval: latest,
      };
    }
    return { allowed: true, approval: latest };
  }
  return { allowed: true };
}
