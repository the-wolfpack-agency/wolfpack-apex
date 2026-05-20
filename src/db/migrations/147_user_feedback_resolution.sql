-- Migration 147 — add resolution columns to instinct_user_feedback.
--
-- CTO needs to mark feedback as addressed on /admin/feedback so the
-- inbox doesn't grow unbounded and "what's still pending" is a
-- one-glance answer. Open vs Resolved.
--
-- Schema notes:
--   - resolved_at NULL means the entry is open. Non-null = resolved.
--   - resolved_by is TEXT to match instinct_team_members.id (the
--     "tm_<random>" format, not UUID).
--   - resolution_note optional — for "fixed in PR #x" style trails.
--   - Index on (workspace_id, resolved_at) so the open-only filter
--     is index-only on the dashboard hot path.

BEGIN;

ALTER TABLE instinct_user_feedback
  ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by      TEXT,
  ADD COLUMN IF NOT EXISTS resolution_note  TEXT;

CREATE INDEX IF NOT EXISTS idx_user_feedback_workspace_open
  ON instinct_user_feedback (workspace_id, created_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON COLUMN instinct_user_feedback.resolved_at IS
  'NULL = open. Non-null = resolved (timestamp of resolution).';
COMMENT ON COLUMN instinct_user_feedback.resolved_by IS
  'instinct_team_members.id of the resolver. TEXT to match the tm_<random> id format.';

COMMIT;
