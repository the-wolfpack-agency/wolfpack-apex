/**
 * section-comments.ts — orchestration over `instinct_site_section_comments`.
 *
 * Path C Phase 3 · Stream R3. Threaded per-section comments for Instinct
 * Sites review flow. Two caller classes:
 *
 *   1. UNAUTH share-link reviewers — post comments through the
 *      `/api/public/share/[token]/comments` route. The route supplies
 *      `shareTokenId` so we can attribute + revoke access later.
 *
 *   2. AUTHED designers — post/reply/resolve/delete through
 *      `/api/sites/[id]/comments/*`. `shareTokenId` is null.
 *
 * Writes go through `writeQuery` with `expectRows: 1` so a silent
 * discard (RLS mismatch, bogus view, trigger rollback) surfaces as a
 * typed error. `listCommentsForSite` uses `safeQuery` because reads in
 * shadow mode legitimately return [].
 *
 * Body is capped at 5000 chars (DB CHECK constraint + lib-level
 * validation with a typed error). The lib rejects before hitting the DB
 * so callers get a deterministic error code, not a pg constraint trace.
 */

import { safeQuery, writeQuery, WriteQueryError } from "@/lib/db";

export interface SectionComment {
  id: string;
  siteId: string;
  shareTokenId: string | null;
  pageIndex: number;
  sectionIndex: number;
  sectionType: string | null;
  body: string;
  actorName: string | null;
  actorEmail: string | null;
  parentCommentId: string | null;
  state: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** Max body length — mirrored by DB CHECK constraint. */
export const COMMENT_BODY_MAX = 5000;

/**
 * Typed error so callers can surface a 400 + "too long" reason without
 * leaking DB internals. Distinct from WriteQueryError so route handlers
 * can catch one without swallowing the other.
 */
export class CommentValidationError extends Error {
  readonly code: "body_empty" | "body_too_long" | "bad_site_id" | "bad_index";
  constructor(
    message: string,
    code: CommentValidationError["code"],
  ) {
    super(message);
    this.name = "CommentValidationError";
    this.code = code;
  }
}

function rowToRecord(row: Record<string, unknown>): SectionComment {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    shareTokenId: (row.share_token_id as string) || null,
    pageIndex: Number(row.page_index),
    sectionIndex: Number(row.section_index),
    sectionType: (row.section_type as string) || null,
    body: String(row.body ?? ""),
    actorName: (row.actor_name as string) || null,
    actorEmail: (row.actor_email as string) || null,
    parentCommentId: (row.parent_comment_id as string) || null,
    state: (row.state as "open" | "resolved") ?? "open",
    resolvedBy: (row.resolved_by as string) || null,
    resolvedAt: (row.resolved_at as string) || null,
    createdAt: String(row.created_at),
  };
}

export interface PostCommentOpts {
  siteId: string;
  shareTokenId?: string;
  pageIndex: number;
  sectionIndex: number;
  sectionType?: string;
  body: string;
  actorName?: string;
  actorEmail?: string;
  parentCommentId?: string;
}

/**
 * Insert a comment row. Writes through `writeQuery` with `expectRows: 1`
 * so a silent discard (RLS, view passthrough gone wrong, trigger
 * rollback) surfaces as a typed error instead of a 200 over empty rows.
 *
 * Validation happens BEFORE the write:
 *   - siteId: non-empty string (FK will also catch it, but we fail-fast)
 *   - body: non-empty after trim, ≤ COMMENT_BODY_MAX chars
 *   - pageIndex / sectionIndex: non-negative integers
 *
 * Actor fields are truncated (defensive — same pattern as approvals) so
 * a malicious/buggy client can't blow the row up to megabytes.
 */
export async function postComment(opts: PostCommentOpts): Promise<SectionComment> {
  if (!opts.siteId || typeof opts.siteId !== "string") {
    throw new CommentValidationError("siteId is required", "bad_site_id");
  }
  if (!Number.isInteger(opts.pageIndex) || opts.pageIndex < 0) {
    throw new CommentValidationError("pageIndex must be a non-negative integer", "bad_index");
  }
  if (!Number.isInteger(opts.sectionIndex) || opts.sectionIndex < 0) {
    throw new CommentValidationError("sectionIndex must be a non-negative integer", "bad_index");
  }
  const bodyTrimmed = (opts.body ?? "").trim();
  if (!bodyTrimmed) {
    throw new CommentValidationError("body must not be empty", "body_empty");
  }
  if (bodyTrimmed.length > COMMENT_BODY_MAX) {
    throw new CommentValidationError(
      `body must be ≤ ${COMMENT_BODY_MAX} chars (got ${bodyTrimmed.length})`,
      "body_too_long",
    );
  }

  const actorName = (opts.actorName ?? "").trim().slice(0, 200) || null;
  const actorEmail = (opts.actorEmail ?? "").trim().slice(0, 320) || null;
  const sectionType = (opts.sectionType ?? "").trim().slice(0, 64) || null;
  const shareTokenId = opts.shareTokenId ?? null;
  const parentCommentId = opts.parentCommentId ?? null;

  const result = await writeQuery<Record<string, unknown>>(
    `INSERT INTO instinct_site_section_comments
       (site_id, share_token_id, page_index, section_index, section_type,
        body, actor_name, actor_email, parent_comment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, site_id, share_token_id, page_index, section_index,
               section_type, body, actor_name, actor_email, parent_comment_id,
               state, resolved_by, resolved_at, created_at`,
    [
      opts.siteId,
      shareTokenId,
      opts.pageIndex,
      opts.sectionIndex,
      sectionType,
      bodyTrimmed,
      actorName,
      actorEmail,
      parentCommentId,
    ],
    { expectRows: 1 },
  );
  return rowToRecord(result.rows[0]);
}

/**
 * List comments for a site. Returns chronological DESC (newest first)
 * so the designer pane can render the most recent thread at the top.
 *
 * `openOnly=true` filters to state='open' — used by the default designer
 * view and the learning-loop KPI queries ("how many unresolved threads
 * per site?").
 */
export async function listCommentsForSite(
  siteId: string,
  opts: { openOnly?: boolean } = {},
): Promise<SectionComment[]> {
  const where = opts.openOnly ? "AND state = 'open'" : "";
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT id, site_id, share_token_id, page_index, section_index,
            section_type, body, actor_name, actor_email, parent_comment_id,
            state, resolved_by, resolved_at, created_at
       FROM instinct_site_section_comments
      WHERE site_id = $1 ${where}
      ORDER BY created_at DESC`,
    [siteId],
  );
  return rows.map(rowToRecord);
}

/**
 * Mark a comment + every descendant reply resolved. The recursive
 * update happens in a single SQL statement via a CTE so we never leave
 * a half-resolved thread on a crash between two separate UPDATEs.
 *
 * Returns the freshly-updated parent row. If the parent was already
 * resolved, the UPDATE still returns the row (no change, idempotent).
 */
export async function resolveComment(opts: {
  commentId: string;
  userId: string;
}): Promise<SectionComment> {
  if (!opts.commentId) {
    throw new CommentValidationError("commentId is required", "bad_site_id");
  }
  const result = await writeQuery<Record<string, unknown>>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM instinct_site_section_comments WHERE id = $1
       UNION ALL
       SELECT c.id
         FROM instinct_site_section_comments c
         JOIN descendants d ON c.parent_comment_id = d.id
     )
     UPDATE instinct_site_section_comments
        SET state = 'resolved',
            resolved_by = $2,
            resolved_at = NOW()
      WHERE id IN (SELECT id FROM descendants)
        AND state = 'open'
     RETURNING id, site_id, share_token_id, page_index, section_index,
               section_type, body, actor_name, actor_email, parent_comment_id,
               state, resolved_by, resolved_at, created_at`,
    [opts.commentId, opts.userId],
  );
  // The RETURNING clause yields every row the recursive CTE touched.
  // Find the parent (id = commentId) so the caller gets the canonical
  // top-level record. If the parent was already resolved it's not in
  // the RETURNING set (WHERE state='open' filter) — fall through to a
  // SELECT so the caller still gets a valid record.
  const parent = result.rows.find((r) => String(r.id) === opts.commentId);
  if (parent) {
    return rowToRecord(parent);
  }
  // Already-resolved case: SELECT the row so the caller's idempotent
  // path still returns a valid record.
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT id, site_id, share_token_id, page_index, section_index,
            section_type, body, actor_name, actor_email, parent_comment_id,
            state, resolved_by, resolved_at, created_at
       FROM instinct_site_section_comments
      WHERE id = $1`,
    [opts.commentId],
  );
  if (rows.length === 0) {
    throw new WriteQueryError(
      `resolveComment: comment ${opts.commentId} not found after recursive update`,
      "unexpected_row_count",
      { expected: 1, actual: 0 },
    );
  }
  return rowToRecord(rows[0]);
}

/**
 * SOFT delete: mark the body as "[deleted]" + preserve the row so the
 * audit trail stays intact (learning loop still counts the thread that
 * spawned a delete — useful signal). The row is NOT physically removed.
 *
 * We also preserve state — if the comment was resolved, it stays
 * resolved. If it was open, it stays open (a moderator could still
 * resolve the tombstone later).
 */
export async function deleteComment(opts: {
  commentId: string;
  userId: string;
}): Promise<void> {
  if (!opts.commentId) {
    throw new CommentValidationError("commentId is required", "bad_site_id");
  }
  // userId currently unused on the UPDATE itself — the analytics event
  // fired at the route layer captures deleted_by_role. We accept it so
  // the signature matches resolveComment + we can attach an audit
  // column later without a signature break.
  void opts.userId;
  await writeQuery(
    `UPDATE instinct_site_section_comments
        SET body = '[deleted]'
      WHERE id = $1`,
    [opts.commentId],
    { expectRows: 1 },
  );
}

/**
 * Convenience accessor — get a single comment row (used by route
 * handlers to resolve metadata for analytics events).
 */
export async function getComment(
  commentId: string,
): Promise<SectionComment | null> {
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT id, site_id, share_token_id, page_index, section_index,
            section_type, body, actor_name, actor_email, parent_comment_id,
            state, resolved_by, resolved_at, created_at
       FROM instinct_site_section_comments
      WHERE id = $1`,
    [commentId],
  );
  return rows.length ? rowToRecord(rows[0]) : null;
}
