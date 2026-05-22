/**
 * record-feedback — persist a `/feedback` submission into
 * `instinct_user_feedback` (migration 143) and emit the
 * `assistant.feedback_recorded` analytics event.
 *
 * Used by:
 *   - The `feedback` assistant tool's handler (slash-command path).
 *   - The /api/feedback POST route (widget-textarea path).
 *
 * Contract:
 *   - Writes go through `writeQuery` so a silent failure surfaces as a
 *     thrown WriteQueryError instead of "the user typed it and nothing
 *     happened" — same rule as every other capture path.
 *   - The analytics event ALWAYS fires AFTER the row commits, so a
 *     dashboard counting `feedback_recorded` never counts a write that
 *     didn't land.
 *   - Workspace isolation is enforced by ALWAYS passing the caller's
 *     workspaceId into the INSERT (no implicit "default" guess).
 */

import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { MAX_FEEDBACK_LENGTH } from "@/lib/feedback/limits";

/**
 * How recent a prior row counts as a duplicate of the current submission.
 *
 * Long enough to absorb network retries, fast-double-click, and the
 * keyboard-shortcut race (Cmd+Enter fired twice before React re-renders
 * the button as disabled). Short enough that an intentional repeat
 * submission of the same text minutes later still creates a new row,
 * because the team genuinely sometimes wants to escalate the same
 * feedback they filed earlier.
 */
export const FEEDBACK_DEDUP_WINDOW_SECONDS = 15;

/* Re-export so existing imports (the assistant tool, the API route,
 * the FeedbackWidget pre-refactor) can keep `import { MAX_FEEDBACK_LENGTH }
 * from "@/lib/feedback/record-feedback"`. */
export { MAX_FEEDBACK_LENGTH };

export interface RecordUserFeedbackInput {
  workspaceId: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  message: string;
  surface?: string;
  userAgent?: string;
  /** Per-turn assistant correlation id; joins this row into the same
   *  funnel as the `assistant.tool_invoked` / `widget_offered` events
   *  emitted by the originating turn. */
  workflowId?: string;
}

export interface RecordUserFeedbackResult {
  /** UUID of the inserted row. The widget shows the first 8 chars as
   *  a human-readable confirmation ("Thanks — recorded as #ab12cd34"). */
  id: string;
  /** ISO timestamp of the inserted row. */
  recordedAt: string;
  /** True when this call resolved an existing row inside the dedup
   *  window instead of inserting a new one. Lets the caller suppress a
   *  second analytics fire so the dashboard count matches actual rows. */
  deduplicated?: boolean;
}

export async function recordUserFeedback(
  input: RecordUserFeedbackInput,
): Promise<RecordUserFeedbackResult> {
  const message = (input.message ?? "").trim();
  if (!message) {
    throw new Error("recordUserFeedback: message is required");
  }
  if (message.length > MAX_FEEDBACK_LENGTH) {
    throw new Error(
      `recordUserFeedback: message exceeds ${MAX_FEEDBACK_LENGTH} chars`,
    );
  }
  if (!input.workspaceId) {
    throw new Error("recordUserFeedback: workspaceId is required");
  }
  if (!input.userId) {
    throw new Error("recordUserFeedback: userId is required");
  }

  /* Dedup: if the same (workspace, user, message) was already
   * captured inside the last FEEDBACK_DEDUP_WINDOW_SECONDS, return
   * that row's id instead of inserting a second copy. This protects
   * against fast-double-click, keyboard-race, and client retry on
   * a slow network. The (workspace_id, created_at DESC) index from
   * migration 143/147 keeps the lookup cheap. */
  try {
    const existing = await query<{ id: string; created_at: string }>(
      `SELECT id, created_at::text AS created_at
         FROM instinct_user_feedback
        WHERE workspace_id = $1
          AND user_id = $2
          AND message = $3
          AND created_at > NOW() - ($4 || ' seconds')::interval
        ORDER BY created_at DESC
        LIMIT 1`,
      [
        input.workspaceId,
        input.userId,
        message,
        String(FEEDBACK_DEDUP_WINDOW_SECONDS),
      ],
    );
    const prior = existing.rows[0];
    if (prior?.id) {
      return {
        id: prior.id,
        recordedAt: prior.created_at,
        deduplicated: true,
      };
    }
  } catch {
    /* Dedup lookup is a best-effort guardrail; if the SELECT fails we
     * still fall through to the INSERT so a transient read error never
     * blocks a legitimate write. */
  }

  const { rows } = await writeQuery<{ id: string; created_at: string }>(
    `INSERT INTO instinct_user_feedback
        (workspace_id, user_id, user_email, user_role, message,
         surface, user_agent, workflow_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, created_at::text AS created_at`,
    [
      input.workspaceId,
      input.userId,
      input.userEmail ?? null,
      input.userRole ?? null,
      message,
      input.surface ?? null,
      input.userAgent ?? null,
      input.workflowId ?? null,
    ],
    { expectRows: 1 },
  );

  const row = rows[0];
  if (!row?.id) {
    /* writeQuery + expectRows:1 already guarantees this, but the explicit
     * narrowing keeps the return-type honest without a `!`. */
    throw new Error("recordUserFeedback: insert returned no id");
  }

  trackEvent(
    "assistant.feedback_recorded",
    input.userId,
    input.userRole ?? "unknown",
    {
      feedback_id: row.id,
      surface: input.surface ?? "unknown",
      message_length: message.length,
      ...(input.workflowId ? { workflow_id: input.workflowId } : {}),
    },
  );

  return { id: row.id, recordedAt: row.created_at };
}
