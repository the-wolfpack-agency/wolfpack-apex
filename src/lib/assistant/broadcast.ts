/**
 * One message, into every user's assistant.
 *
 * The assistant is where people already are, so it is the right place to reach
 * them: no second inbox, no extra clicking. Somebody with something to tell the
 * whole company writes it once and it appears in each person's thread.
 *
 * ONE-WAY ON PURPOSE. Replies would need a thread model the chat does not
 * have, and the answer to "I have a question about this" is the feedback form
 * that already exists rather than a conversation nobody is watching.
 *
 * THE HAZARD, which is not obvious and is the whole reason this file exists.
 *
 * The org-wide answer cache reads assistant messages from ANY conversation and
 * replays them to the whole workspace, and the knowledge base promotes answers
 * to curated facts. A broadcast stored as an ordinary assistant message would
 * therefore become a cacheable ANSWER: "submit expenses by Friday" served to
 * somebody who asked about expense policy three weeks later, and eventually
 * written into the knowledge base as a fact about this company.
 *
 * That is not hypothetical. On 2026-08-27 a general-knowledge answer about
 * brand ambassadors was cached, served ahead of the Brain that held the real
 * training material, and promoted into instinct_knowledge as curated content.
 * Four separate layers could answer ahead of the documents and none of them
 * knew whether an answer stood on anything.
 *
 * So a broadcast carries its own source. It is never an answer, never cached,
 * never promoted, and never counted in the deterministic-share figures, which
 * measure questions the product answered rather than messages it delivered.
 */

import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { query } from "@/lib/db";
import { gateAnswer } from "@/lib/assistant/answer-gate";

/** How the recipient list was resolved, so a partial send is never silent. */
export interface BroadcastResult {
  /** People the message was written to. */
  delivered: number;
  /** People we could not write to, and why. */
  failed: number;
  /** True when the recipient list itself could not be read. */
  readable: boolean;
  /** Personal-data kinds removed before sending, if any. */
  redacted: string[];
}

export interface BroadcastInput {
  message: string;
  workspaceId: string;
  actorId: string;
  actorRole: string;
  /** Optional deep link the UI renders under the message. */
  actionUrl?: string;
  actionLabel?: string;
  /**
   * Attach the feedback form to the message. Defaults to true.
   *
   * This is the answer to "it is one-way, so how does anyone respond". Rather
   * than a reply the chat has no thread model for, the announcement carries
   * the feedback compose form that already exists, rendered inline by the
   * assistant's existing widget renderer. Responses land in the feedback
   * table with the rest, so there is one queue to read instead of a second
   * inbox nobody watches.
   */
  allowFeedback?: boolean;
}

/** Longer than this is a document, not an announcement. */
export const MAX_BROADCAST_CHARS = 2000;


/**
 * Who a broadcast would reach.
 *
 * Shared with the compose surface deliberately. The number shown in "send to
 * 42 people" has to come from the query that will actually do the sending, or
 * the confirmation is describing a different set from the one that receives
 * it, and a sender is agreeing to something that was never true.
 */
export async function listRecipients(
  workspaceId: string,
): Promise<{ recipients: { id: string }[]; readable: boolean }> {
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM instinct_team_members
        WHERE workspace_id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
      [workspaceId],
    );
    return { recipients: rows, readable: true };
  } catch {
    return { recipients: [], readable: false };
  }
}

export async function broadcastToAssistants(
  input: BroadcastInput,
): Promise<BroadcastResult> {
  const text = input.message.trim();
  if (!text) {
    return { delivered: 0, failed: 0, readable: true, redacted: [] };
  }
  if (text.length > MAX_BROADCAST_CHARS) {
    throw new Error(
      `A broadcast may be at most ${MAX_BROADCAST_CHARS} characters. This one is ${text.length}.`,
    );
  }

  /* THROUGH THE SAME GATE AS AN ANSWER. A broadcast goes to everybody, so it
     is the last thing that should carry a personal identifier somebody pasted
     in without thinking. */
  const gated = gateAnswer({
    text,
    source: "broadcast",
    userId: input.actorId,
    userRole: input.actorRole,
  });

  const listed = await listRecipients(input.workspaceId);
  if (!listed.readable) {
    /* An unreadable recipient list is not an empty one, and reporting zero
       delivered as a successful send is how somebody assumes the company was
       told something it was not. */
    return { delivered: 0, failed: 0, readable: false, redacted: gated.removed };
  }
  const recipients = listed.recipients;

  let delivered = 0;
  let failed = 0;
  for (const r of recipients) {
    try {
      await deliverToUser(r.id, gated.text, input);
      delivered += 1;
    } catch {
      /* One unreachable person must not stop the other ninety-nine. */
      failed += 1;
    }
  }

  trackEvent("assistant.broadcast_sent", input.actorId, input.actorRole, {
    workspace_id: input.workspaceId,
    recipients: recipients.length,
    delivered,
    failed,
    chars: gated.text.length,
    redacted: gated.removed.join(",") || "none",
  });

  /* Hash-chained, because writing into every person's assistant is a
     privileged action and "who sent this to the whole company" is a question
     somebody will eventually ask. */
  await recordAudit({
    actor: { user_id: input.actorId, role: input.actorRole },
    action: "assistant.broadcast_sent",
    resourceType: "assistant_broadcast",
    afterState: {
      recipients: recipients.length,
      delivered,
      failed,
      chars: gated.text.length,
    },
  }).catch(() => undefined);

  return { delivered, failed, readable: true, redacted: gated.removed };
}

/**
 * Write the message into one person's assistant.
 *
 * Its own conversation, rather than whichever thread they last used. Dropping
 * an announcement into the middle of somebody's half-finished question reads
 * as the assistant interrupting itself, and it puts unrelated text next to a
 * question in the history the cache reads.
 */
async function deliverToUser(
  userId: string,
  text: string,
  input: BroadcastInput,
): Promise<void> {
  /* last_message_at, not updated_at. This table has no updated_at column, and
     the draft that assumed it would have thrown on the first real send. The
     conversation list orders on last_message_at, so an announcement that did
     not set it would arrive at the bottom of somebody's history. */
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_conversations
       (user_id, title, created_at, last_message_at, message_count)
     VALUES ($1, $2, NOW(), NOW(), 1)
     RETURNING id`,
    [userId, "Announcement"],
  );
  const conversationId = rows[0]?.id;
  if (!conversationId) throw new Error("no conversation");

  await query(
    `INSERT INTO instinct_messages
       (conversation_id, role, content, source, tokens_used, metadata)
     VALUES ($1, 'assistant', $2, 'broadcast', 0, $3::jsonb)`,
    [
      conversationId,
      text,
      JSON.stringify({
        broadcast: true,
        from_user_id: input.actorId,
        ...(input.actionUrl ? { action_url: input.actionUrl } : {}),
        ...(input.actionLabel ? { action_label: input.actionLabel } : {}),
        /* The existing widget, not a new surface. The assistant already
           renders metadata.widget, and a compose-mode feedback spec is the
           form it already knows how to draw and submit. */
        ...(input.allowFeedback === false
          ? {}
          : { widget: { kind: "feedback", mode: "compose", surface: "broadcast" } }),
      }),
    ],
  );
}
