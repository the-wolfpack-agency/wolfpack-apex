-- Migration 144 — fix instinct_user_feedback column types to match
-- the rest of the schema.
--
-- Migration 143 declared workspace_id / user_id / workflow_id as UUID,
-- but the rest of the codebase keys workspaces by TEXT (see
-- instinct_workspace.id, migration 015) with a literal 'default'
-- fallback, and team_members.id is TEXT in the `tm_<random>` format
-- (e.g. "tm_f7e52863-a45"). When a /feedback submission from a user in
-- the default workspace hit the INSERT, Postgres rejected it with
-- `invalid input syntax for type uuid: "default"` — the row never
-- wrote and the assistant returned an error to the user.
--
-- The 2026-05-20 CTO screenshot of "/feedback instinct is fun"
-- failing with that exact message is the smoking gun. Every other
-- workspace-scoped table in the schema (137, 139, 140, 142) uses
-- TEXT — 143 was the lone outlier.
--
-- Idempotent: ALTER ... TYPE TEXT is a no-op if the column is already
-- TEXT, and the SET DEFAULT only applies to future inserts.

BEGIN;

ALTER TABLE instinct_user_feedback
  ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::TEXT,
  ALTER COLUMN user_id      TYPE TEXT USING user_id::TEXT,
  ALTER COLUMN workflow_id  TYPE TEXT USING workflow_id::TEXT;

ALTER TABLE instinct_user_feedback
  ALTER COLUMN workspace_id SET DEFAULT 'default';

COMMENT ON COLUMN instinct_user_feedback.workspace_id IS
  'Workspace owning this feedback row. TEXT to match instinct_workspace.id and the lib-level "default" fallback for pre-migration-137 sessions.';
COMMENT ON COLUMN instinct_user_feedback.user_id IS
  'instinct_team_members.id of the submitter — TEXT to match the tm_<random> format.';

COMMIT;
