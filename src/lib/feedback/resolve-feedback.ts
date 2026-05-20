/**
 * resolve-feedback — mark / unmark an instinct_user_feedback row as
 * resolved. Workspace-scoped, writeQuery, analytics on every action.
 */

import { writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export const MAX_RESOLUTION_NOTE_LENGTH = 500;

export interface ResolveFeedbackInput {
  workspaceId: string;
  feedbackId: string;
  resolverId: string;
  resolverRole?: string;
  /** Optional "fixed in PR #X" trail; truncated to 500 chars. */
  note?: string;
}

export interface ReopenFeedbackInput {
  workspaceId: string;
  feedbackId: string;
  reopenerId: string;
  reopenerRole?: string;
}

export interface ResolvedRow {
  id: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export async function resolveFeedback(
  input: ResolveFeedbackInput,
): Promise<ResolvedRow> {
  if (!input.workspaceId) throw new Error("resolveFeedback: workspaceId required");
  if (!input.feedbackId) throw new Error("resolveFeedback: feedbackId required");
  if (!input.resolverId) throw new Error("resolveFeedback: resolverId required");
  const note = (input.note ?? "").trim().slice(0, MAX_RESOLUTION_NOTE_LENGTH) || null;

  const { rows } = await writeQuery<ResolvedRow>(
    `UPDATE instinct_user_feedback
     SET resolved_at = NOW(),
         resolved_by = $1,
         resolution_note = $2
     WHERE id = $3 AND workspace_id = $4
     RETURNING id, resolved_at::text AS resolved_at, resolved_by, resolution_note`,
    [input.resolverId, note, input.feedbackId, input.workspaceId],
    { expectRows: 1 },
  );
  const row = rows[0];
  if (!row) throw new Error("resolveFeedback: row not found in workspace");

  trackEvent(
    "system.feedback_resolved",
    input.resolverId,
    input.resolverRole ?? "unknown",
    { feedback_id: input.feedbackId, has_note: Boolean(note) },
  );

  return row;
}

export async function reopenFeedback(
  input: ReopenFeedbackInput,
): Promise<ResolvedRow> {
  if (!input.workspaceId) throw new Error("reopenFeedback: workspaceId required");
  if (!input.feedbackId) throw new Error("reopenFeedback: feedbackId required");
  if (!input.reopenerId) throw new Error("reopenFeedback: reopenerId required");

  const { rows } = await writeQuery<ResolvedRow>(
    `UPDATE instinct_user_feedback
     SET resolved_at = NULL,
         resolved_by = NULL,
         resolution_note = NULL
     WHERE id = $1 AND workspace_id = $2
     RETURNING id, resolved_at::text AS resolved_at, resolved_by, resolution_note`,
    [input.feedbackId, input.workspaceId],
    { expectRows: 1 },
  );
  const row = rows[0];
  if (!row) throw new Error("reopenFeedback: row not found in workspace");

  trackEvent(
    "system.feedback_reopened",
    input.reopenerId,
    input.reopenerRole ?? "unknown",
    { feedback_id: input.feedbackId },
  );

  return row;
}
