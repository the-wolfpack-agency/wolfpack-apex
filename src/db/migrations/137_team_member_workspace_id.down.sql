-- Down migration for 137_team_member_workspace_id
--
-- Drops the FKs, index, and workspace_id columns so the schema
-- returns to the pre-multi-workspace shape. Safe to run because
-- every backfilled row used the singleton "default" tenant.

BEGIN;

ALTER TABLE instinct_team_members DROP CONSTRAINT IF EXISTS instinct_team_members_workspace_fk;
ALTER TABLE instinct_invites      DROP CONSTRAINT IF EXISTS instinct_invites_workspace_fk;

DROP INDEX IF EXISTS idx_team_members_workspace;

ALTER TABLE instinct_team_members DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE instinct_invites      DROP COLUMN IF EXISTS workspace_id;

COMMIT;
