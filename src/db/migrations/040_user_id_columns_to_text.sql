-- Widen user-id columns from UUID to TEXT to match the actual identifier
-- shape used by the auth layer.
--
-- ROOT CAUSE (surfaced by a designer upload on 2026-04-19):
--   The auth layer issues user identifiers like "demo-cto" for seeded
--   demo accounts. Those are stable string slugs, NOT UUIDs. Tables
--   that typed `uploaded_by`, `created_by`, or similar columns as UUID
--   rejected every write from a demo account with:
--     writeQuery failed: invalid input syntax for type uuid: "demo-cto"
--
--   The TEXT-typed sibling columns (requested_by in migrations 031/032,
--   added_by in 033) worked fine. This migration unifies the schema on
--   TEXT for every user-id column we wrote since migration 034.
--
-- WHY TEXT instead of tightening the auth layer to UUIDs:
--   Auth identifiers flow from multiple sources — demo account seeds
--   (string slugs), real auth provider tokens (GitHub numeric IDs for
--   the bot account, UUIDs for everyone else). The app's job is to
--   treat user-id as an opaque identifier. Forcing a column to be UUID
--   would tie the DB schema to a choice of auth provider that should
--   stay an internal implementation detail.
--
-- Affected columns (both sourced from agents that picked UUID
-- reasonably but incorrectly):
--   - apex_share_tokens.created_by              (migration 035)
--   - apex_site_approvals.share_token_id        — leave as UUID, this is
--                                                  a FK to apex_share_tokens.id
--                                                  which IS a UUID. Skipping.
--   - instinct_client_assets.uploaded_by        (migration 038)
--
-- Defensive per feedback_migration_safety.md. Wrapped in a DO block so
-- re-runs on already-migrated DBs are no-ops. Every ALTER is guarded
-- against both "column missing" and "column already TEXT".

BEGIN;

DO $$
DECLARE
  col_type TEXT;
BEGIN
  -- apex_share_tokens.created_by
  --
  -- The `instinct_share_tokens` view from migration 035 is a simple
  -- `SELECT * FROM apex_share_tokens` pass-through, which means
  -- Postgres's dependency tracker blocks `ALTER COLUMN ... TYPE` on
  -- any column the view references. The column-type change is
  -- structurally safe (UUID can cast to TEXT without data loss), but
  -- we have to drop the view before the ALTER and recreate it after.
  -- Any table rows stay put across this — views are pure metadata.
  --
  -- First deploy on 2026-04-19 hit exactly this: error 0A000,
  -- `rule _RETURN on view instinct_share_tokens depends on column
  -- created_by`.
  SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'apex_share_tokens'
      AND column_name = 'created_by';
  IF col_type = 'uuid' THEN
    -- Drop the dependent view so Postgres lets us retype the column.
    -- IF EXISTS so the migration also runs on fresh DBs where the
    -- view isn't present yet (e.g. a new tenant post-035-recreate).
    EXECUTE 'DROP VIEW IF EXISTS instinct_share_tokens';
    EXECUTE 'ALTER TABLE apex_share_tokens ALTER COLUMN created_by TYPE TEXT USING created_by::text';
    -- Recreate the view exactly as 035 defined it. `SELECT *` auto-
    -- adopts the new TEXT type so callers see the widened column
    -- without any code change.
    EXECUTE 'CREATE OR REPLACE VIEW instinct_share_tokens AS SELECT * FROM apex_share_tokens';
    RAISE NOTICE 'apex_share_tokens.created_by: UUID → TEXT (view rebuilt)';
  ELSIF col_type = 'text' THEN
    -- Already widened. Make sure the view still exists (idempotent
    -- recovery — if a prior migration attempt dropped the view but
    -- failed before recreate, this restores it).
    EXECUTE 'CREATE OR REPLACE VIEW instinct_share_tokens AS SELECT * FROM apex_share_tokens';
    RAISE NOTICE 'apex_share_tokens.created_by is already TEXT — ensured view exists.';
  ELSIF col_type IS NULL THEN
    RAISE NOTICE 'apex_share_tokens.created_by does not exist — skipping.';
  ELSE
    RAISE EXCEPTION 'apex_share_tokens.created_by is unexpected type %', col_type;
  END IF;

  -- instinct_client_assets.uploaded_by
  SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'instinct_client_assets'
      AND column_name = 'uploaded_by';
  IF col_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE instinct_client_assets ALTER COLUMN uploaded_by TYPE TEXT USING uploaded_by::text';
    RAISE NOTICE 'instinct_client_assets.uploaded_by: UUID → TEXT';
  ELSIF col_type = 'text' THEN
    RAISE NOTICE 'instinct_client_assets.uploaded_by is already TEXT — skipping.';
  ELSIF col_type IS NULL THEN
    RAISE NOTICE 'instinct_client_assets.uploaded_by does not exist — skipping.';
  ELSE
    RAISE EXCEPTION 'instinct_client_assets.uploaded_by is unexpected type %', col_type;
  END IF;
END $$;

COMMIT;
