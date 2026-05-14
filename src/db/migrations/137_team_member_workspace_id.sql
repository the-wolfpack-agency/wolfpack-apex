-- Migration 137 — multi-workspace switch
--
-- Until now, every team member implicitly belonged to the singleton
-- workspace "default" (created by migration 015). All connector
-- credentials (136), strictness settings (133), and assistant tools
-- key by workspace_id, but the *team member* row had no workspace
-- pointer — so every route was hardcoded to read workspace_id="default".
--
-- This migration:
--   1. Adds workspace_id to instinct_team_members (FK to instinct_workspace.id)
--   2. Adds workspace_id to instinct_invites so an invite knows which
--      workspace it grants membership to
--   3. Backfills both to "default" so existing rows stay in the
--      singleton tenant
--   4. Adds an index for the hot "members of workspace X" lookup
--
-- After this lands, the JWT carries workspace_id, every route reads it
-- from the session, and a new workspace can be created by inserting
-- a row into instinct_workspace + assigning members to it.

BEGIN;

ALTER TABLE instinct_team_members
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE instinct_invites
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';

-- Backfill any rows that pre-existed the DEFAULT clause (defensive;
-- the DEFAULT alone covers fresh inserts but not historical NULLs if
-- the column had been added without DEFAULT in some earlier branch).
UPDATE instinct_team_members SET workspace_id = 'default' WHERE workspace_id IS NULL;
UPDATE instinct_invites      SET workspace_id = 'default' WHERE workspace_id IS NULL;

-- Hot path: list all members of a workspace.
CREATE INDEX IF NOT EXISTS idx_team_members_workspace
  ON instinct_team_members (workspace_id);

-- FK only if instinct_workspace exists in this environment (migration 015).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'instinct_workspace') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'instinct_team_members_workspace_fk'
    ) THEN
      ALTER TABLE instinct_team_members
        ADD CONSTRAINT instinct_team_members_workspace_fk
        FOREIGN KEY (workspace_id) REFERENCES instinct_workspace(id)
        ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'instinct_invites_workspace_fk'
    ) THEN
      ALTER TABLE instinct_invites
        ADD CONSTRAINT instinct_invites_workspace_fk
        FOREIGN KEY (workspace_id) REFERENCES instinct_workspace(id)
        ON DELETE RESTRICT;
    END IF;
  END IF;
END$$;

-- Sanity: every active team member ended up in a workspace.
DO $$
DECLARE
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
    FROM instinct_team_members
   WHERE workspace_id IS NULL OR workspace_id = '';
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Migration 137 left % team members without a workspace_id', orphan_count;
  END IF;
END$$;

COMMENT ON COLUMN instinct_team_members.workspace_id IS
  'Tenant the member belongs to. JWT carries this; every workspace-scoped read filters by it.';
COMMENT ON COLUMN instinct_invites.workspace_id IS
  'Workspace the invite grants membership to (set from inviter.workspace_id at invite-creation time).';

COMMIT;
