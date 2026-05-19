-- Migration 143 — instinct_user_feedback (free-form feedback captured
-- by the assistant's `/feedback` slash command).
--
-- The CTO wanted a frictionless "drop a thought, see it stored" path so
-- the team-onboarding session (Wed/Thu) can solicit honest reactions
-- without first wiring up Slack / Linear. The flow is: user types
-- `/feedback <message>` into the assistant, the tool's handler writes
-- a row here, fires the `assistant.feedback_recorded` analytics event,
-- and returns a thank-you widget that echoes the captured text.
--
-- Workspace isolation is enforced at the application layer (every
-- read/write passes a workspace_id WHERE clause) — same pattern the
-- rest of the instinct_* schema uses. No RLS policy without matching
-- session.user.workspace_id GUC plumbing; the cargo-cult would be
-- worse than the explicit lib-level filter, and the existing
-- guardrails (writeQuery row-count, lib-level workspace passthrough)
-- already prevent the cross-tenant leak this would otherwise risk.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_user_feedback (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  /* Workspace the feedback belongs to. The lib filters every read by
   * this so workspace A's CTO never sees workspace B's notes. */
  workspace_id  UUID         NOT NULL,
  /* Authenticated user who submitted the feedback. */
  user_id       UUID         NOT NULL,
  /* Snapshot of the user's email at submission time — keeps the row
   * useful even if the user is later removed from the workspace. */
  user_email    TEXT,
  /* Snapshot of the user's role (cto, ceo, sales, ops, hr, …) so the
   * dashboard slice can group "what is sales saying this week" without
   * re-joining the user table at read time. */
  user_role     TEXT,
  /* The verbatim message the user typed. Capped at 2000 chars in the
   * API/tool layers; no length CHECK here so a future bump doesn't
   * require a migration. */
  message       TEXT         NOT NULL,
  /* Where in the product the feedback was filed from (e.g. "/assistant",
   * "/sites", "/brain"). Optional — surface-attribution is best-effort
   * because some entry points (raw API) won't know. */
  surface       TEXT,
  /* User agent at submission — handy when a complaint is browser
   * specific. NULL when the API caller doesn't pass it (server-side
   * callers, tests). */
  user_agent    TEXT,
  /* Per-turn assistant correlation id (UUID v4 from chat()). Joins
   * this row into the same funnel as `assistant.tool_invoked`,
   * `assistant.widget_offered`, and the rest of the per-turn signals
   * so the learning loop can see "the user asked X, got the feedback
   * widget, submitted this" without a fragile timestamp correlation. */
  workflow_id   UUID,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

/* Hot lookup for the dashboard timeline view: "show the most recent N
 * pieces of feedback in workspace W". The DESC ordering matches the
 * dashboard query so the planner does an index-only walk. */
CREATE INDEX IF NOT EXISTS idx_user_feedback_workspace_created
  ON instinct_user_feedback (workspace_id, created_at DESC);

COMMENT ON TABLE  instinct_user_feedback IS
  'Free-form user feedback captured by the assistant /feedback command. Workspace-scoped in the application layer (see src/lib/feedback/record-feedback.ts).';
COMMENT ON COLUMN instinct_user_feedback.workflow_id IS
  'Per-turn assistant correlation id; joins to assistant.tool_invoked / widget_offered events for funnel analytics.';

COMMIT;
