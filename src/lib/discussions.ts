/**
 * Discussion Library — Collaborative threads for team communication.
 *
 * Threads with replies, pinning (role-gated), resolution tracking.
 * Every action feeds the analytics learning loop.
 */

import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { type TeamRole, hasRole } from "@/lib/auth";

export type DiscussionCategory = "product" | "client" | "engineering" | "process" | "general";
export type DiscussionStatus = "open" | "resolved" | "archived";

export interface Discussion {
  id: string;
  title: string;
  category: DiscussionCategory;
  created_by: string;
  status: DiscussionStatus;
  pinned: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
  reply_count?: number;
}

export interface DiscussionReply {
  id: string;
  discussion_id: string;
  author_id: string;
  content: string;
  attachments: unknown[];
  created_at: string;
  author_name?: string;
  author_role?: string;
}

export interface ThreadDetail {
  discussion: Discussion;
  replies: DiscussionReply[];
}

/**
 * Create a new discussion thread with an initial reply.
 */
export async function createThread(
  title: string,
  category: DiscussionCategory,
  userId: string,
  initialContent: string,
  tags?: string[],
): Promise<Discussion | null> {
  // Insert discussion
  const { rows: discussions } = await safeQuery<Discussion>(
    `INSERT INTO instinct_discussions (title, category, created_by, tags)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [title, category, userId, tags || []],
  );

  if (discussions.length === 0) {
    // Shadow mode
    const demo: Discussion = {
      id: `demo-disc-${Date.now()}`,
      title,
      category,
      created_by: userId,
      status: "open",
      pinned: false,
      tags: tags || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      reply_count: 1,
    };
    return demo;
  }

  const discussion = discussions[0];

  // Insert the initial reply
  await safeQuery(
    `INSERT INTO instinct_discussion_replies (discussion_id, author_id, content)
     VALUES ($1, $2, $3)`,
    [discussion.id, userId, initialContent],
  );

  trackEvent("discussion.thread_created", userId, "unknown", {
    discussion_id: discussion.id,
    category,
    title,
  });

  return { ...discussion, reply_count: 1 };
}

/**
 * Reply to an existing thread.
 */
export async function replyToThread(
  discussionId: string,
  userId: string,
  content: string,
  attachments?: unknown[],
): Promise<DiscussionReply | null> {
  const { rows } = await safeQuery<DiscussionReply>(
    `INSERT INTO instinct_discussion_replies (discussion_id, author_id, content, attachments)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [discussionId, userId, content, JSON.stringify(attachments || [])],
  );

  if (rows.length > 0) {
    // Bump the discussion updated_at
    await safeQuery(
      `UPDATE instinct_discussions SET updated_at = NOW() WHERE id = $1`,
      [discussionId],
    );

    trackEvent("discussion.reply_posted", userId, "unknown", {
      discussion_id: discussionId,
      reply_id: rows[0].id,
    });
    return rows[0];
  }

  // Shadow mode
  return {
    id: `demo-reply-${Date.now()}`,
    discussion_id: discussionId,
    author_id: userId,
    content,
    attachments: attachments || [],
    created_at: new Date().toISOString(),
  };
}

/**
 * Mark a thread as resolved.
 */
export async function resolveThread(
  discussionId: string,
  userId: string,
): Promise<Discussion | null> {
  const { rows } = await safeQuery<Discussion>(
    `UPDATE instinct_discussions
     SET status = 'resolved', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [discussionId],
  );

  if (rows.length > 0) {
    trackEvent("discussion.resolved", userId, "unknown", {
      discussion_id: discussionId,
    });
    return rows[0];
  }
  return null;
}

/**
 * List threads with optional filters. Includes reply count.
 */
export async function getThreads(
  category?: DiscussionCategory,
  status?: DiscussionStatus,
): Promise<Discussion[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (category) {
    conditions.push(`d.category = $${idx++}`);
    params.push(category);
  }
  if (status) {
    conditions.push(`d.status = $${idx++}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await safeQuery<Discussion>(
    `SELECT d.*, COALESCE(r.cnt, 0)::int AS reply_count
     FROM instinct_discussions d
     LEFT JOIN (
       SELECT discussion_id, COUNT(*) AS cnt
       FROM instinct_discussion_replies
       GROUP BY discussion_id
     ) r ON r.discussion_id = d.id
     ${where}
     ORDER BY d.pinned DESC, d.updated_at DESC`,
    params,
  );
  return rows;
}

/**
 * Get a single thread with all replies and author info.
 */
export async function getThread(discussionId: string): Promise<ThreadDetail | null> {
  const { rows: discussions } = await safeQuery<Discussion>(
    `SELECT d.*, COALESCE(r.cnt, 0)::int AS reply_count
     FROM instinct_discussions d
     LEFT JOIN (
       SELECT discussion_id, COUNT(*) AS cnt
       FROM instinct_discussion_replies
       GROUP BY discussion_id
     ) r ON r.discussion_id = d.id
     WHERE d.id = $1`,
    [discussionId],
  );

  if (discussions.length === 0) return null;

  const { rows: replies } = await safeQuery<DiscussionReply>(
    `SELECT dr.*, tm.name AS author_name, tm.role AS author_role
     FROM instinct_discussion_replies dr
     LEFT JOIN apex_team_members tm ON tm.id = dr.author_id
     WHERE dr.discussion_id = $1
     ORDER BY dr.created_at ASC`,
    [discussionId],
  );

  return { discussion: discussions[0], replies };
}

/**
 * Toggle pinned status. Requires cto or dev role.
 */
export async function pinThread(
  discussionId: string,
  userId: string,
  userRole: TeamRole,
): Promise<{ pinned: boolean } | { error: string }> {
  if (!hasRole(userRole, "dev")) {
    return { error: "Insufficient permissions. Requires dev or cto role." };
  }

  const { rows } = await safeQuery<{ pinned: boolean }>(
    `UPDATE instinct_discussions
     SET pinned = NOT pinned, updated_at = NOW()
     WHERE id = $1
     RETURNING pinned`,
    [discussionId],
  );

  if (rows.length > 0) {
    trackEvent("discussion.thread_created", userId, userRole, {
      discussion_id: discussionId,
      action: "pin_toggled",
      pinned: rows[0].pinned,
    });
    return { pinned: rows[0].pinned };
  }
  return { error: "Discussion not found" };
}
