BEGIN;
DROP INDEX IF EXISTS idx_user_feedback_workspace_open;
ALTER TABLE instinct_user_feedback
  DROP COLUMN IF EXISTS resolved_at,
  DROP COLUMN IF EXISTS resolved_by,
  DROP COLUMN IF EXISTS resolution_note;
COMMIT;
