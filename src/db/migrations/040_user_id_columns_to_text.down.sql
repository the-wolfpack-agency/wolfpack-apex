-- Reverse of 040_user_id_columns_to_text.sql. Narrows TEXT back to UUID.
-- WARNING: this REJECTS rows whose values aren't valid UUID literals
-- (e.g. the "demo-cto" strings that caused the original bug). If real
-- non-UUID data has been written, this migration will fail — which is
-- the correct behavior for rolling back a widening change.

BEGIN;

DO $$
DECLARE
  col_type TEXT;
BEGIN
  -- instinct_client_assets.uploaded_by
  SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'instinct_client_assets'
      AND column_name = 'uploaded_by';
  IF col_type = 'text' THEN
    EXECUTE 'ALTER TABLE instinct_client_assets ALTER COLUMN uploaded_by TYPE UUID USING uploaded_by::uuid';
  END IF;

  -- apex_share_tokens.created_by — must drop the dependent view first
  -- per the 2026-04-19 post-mortem on the up-migration. WARNING: the
  -- narrowing USING ::uuid cast will REJECT rows whose values aren't
  -- valid UUID literals (which was the bug that prompted the widen in
  -- the first place). Correct behavior for a rollback.
  SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'apex_share_tokens'
      AND column_name = 'created_by';
  IF col_type = 'text' THEN
    EXECUTE 'DROP VIEW IF EXISTS instinct_share_tokens';
    EXECUTE 'ALTER TABLE apex_share_tokens ALTER COLUMN created_by TYPE UUID USING created_by::uuid';
    EXECUTE 'CREATE OR REPLACE VIEW instinct_share_tokens AS SELECT * FROM apex_share_tokens';
  END IF;
END $$;

COMMIT;
