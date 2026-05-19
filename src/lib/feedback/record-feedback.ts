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

import { writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { MAX_FEEDBACK_LENGTH } from "@/lib/feedback/limits";

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
