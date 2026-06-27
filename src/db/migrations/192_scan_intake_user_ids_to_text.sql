-- Migration 192 - widen user-identity + workspace_id columns to TEXT on the
-- document-intake tables (receipt scans, AP invoices, HR scanned docs,
-- document recognitions, user feedback).
--
-- ROOT CAUSE (same class as migrations 040 and 144):
--   The auth layer issues user identifiers as opaque strings - seeded
--   demo accounts like "demo-cto" and team-member ids in the
--   `tm_<random>` format (e.g. "tm_f7e52863-a45"). Workspaces are keyed
--   TEXT (instinct_workspace.id, migration 015) with a literal 'default'
--   fallback. Migrations 153/154/155/158/143 typed user-identity and
--   workspace columns as UUID, so every write from a non-UUID identity
--   fails with:
--       invalid input syntax for type uuid: "demo-cto"
--   (or "default" for the workspace column). The row never writes and
--   the user sees an error - the exact production bug class that 040 and
--   144 already fixed for earlier tables.
--
-- WHY a follow-up migration instead of editing 153/154/155/158/143 in
-- place:
--   Those migrations have been deployed and green in CI for over a month
--   (landed 2026-05-19 .. 2026-05-22). Per .ai/conventions.md we never
--   rewrite landed migrations, and a `CREATE TABLE IF NOT EXISTS` edit
--   would be a no-op on every already-deployed DB (the table already
--   exists), leaving the UUID columns in place. An additive ALTER is the
--   only deploy-safe fix.
--
-- WHY TEXT instead of tightening auth to UUIDs: identical reasoning to
--   migration 040 - user-id is an opaque identifier whose shape must not
--   leak the auth provider choice into the schema.
--
-- Idempotent + defensive: each ALTER runs only when the column is still
-- UUID, is a no-op when already TEXT, and is skipped when the column /
-- table is absent (fresh DBs, partial deploys). UUID → TEXT casts without
-- data loss.

BEGIN;

DO $$
DECLARE
  -- (table_name, column_name) pairs to widen. Every entry is a user
  -- identity (string slug / tm_<random>) or a TEXT-keyed workspace id.
  pair    TEXT[];
  pairs   TEXT[][] := ARRAY[
    -- 143_user_feedback: workflow_id was left UUID by 144 (it only fixed
    -- workspace_id + user_id). workflow_id correlates chat turns and is a
    -- string id too - widen it here for completeness.
    ARRAY['instinct_user_feedback',          'workflow_id'],
    -- 153_receipt_scans
    ARRAY['instinct_receipt_scans',          'workspace_id'],
    ARRAY['instinct_receipt_scans',          'uploaded_by'],
    -- 154_invoices
    ARRAY['instinct_invoices',               'workspace_id'],
    ARRAY['instinct_invoices',               'uploaded_by'],
    ARRAY['instinct_invoices',               'approved_by'],
    -- 155_hr_scanned_documents
    ARRAY['instinct_hr_scanned_documents',   'workspace_id'],
    ARRAY['instinct_hr_scanned_documents',   'uploaded_by'],
    ARRAY['instinct_hr_scanned_documents',   'team_member_id'],
    ARRAY['instinct_hr_scanned_documents',   'verified_by'],
    -- 158_document_recognitions (workspace_id already TEXT in 158)
    ARRAY['instinct_document_recognitions',  'uploaded_by']
  ];
  tbl       TEXT;
  col       TEXT;
  col_type  TEXT;
  i         INT;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    tbl := pairs[i][1];
    col := pairs[i][2];

    SELECT data_type INTO col_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = tbl
        AND column_name = col;

    IF col_type = 'uuid' THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE TEXT USING %I::text',
        tbl, col, col
      );
      RAISE NOTICE '%.%: UUID -> TEXT', tbl, col;
    ELSIF col_type = 'text' THEN
      RAISE NOTICE '%.% is already TEXT - skipping', tbl, col;
    ELSIF col_type IS NULL THEN
      RAISE NOTICE '%.% does not exist - skipping', tbl, col;
    ELSE
      RAISE EXCEPTION '%.% is unexpected type %', tbl, col, col_type;
    END IF;
  END LOOP;
END $$;

-- Match the workspace default convention established in migration 144 so
-- inserts from pre-migration-137 sessions land in 'default'.
DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'instinct_receipt_scans',
    'instinct_invoices',
    'instinct_hr_scanned_documents'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = tbl
          AND column_name = 'workspace_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET DEFAULT ''default''', tbl);
    END IF;
  END LOOP;
END $$;

COMMIT;
