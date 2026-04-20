-- Down migration: reverse apex_messages → instinct_messages
BEGIN;

DO $$
BEGIN
  -- Drop compat view first (it depends on the renamed table)
  EXECUTE 'DROP VIEW IF EXISTS apex_messages';


  -- Reverse the rename only if instinct is a table and apex is absent
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_messages' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_messages' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_messages RENAME TO apex_messages';
    -- Restore migration-014 alias view
    EXECUTE 'CREATE OR REPLACE VIEW instinct_messages AS SELECT * FROM apex_messages';
  END IF;

  -- Recreate any aggregate views pointing back at apex name

END $$;

-- Rename indexes back
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname LIKE 'idx_instinct_messages_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname,
                    replace(r.indexname, 'idx_instinct_messages_', 'idx_apex_messages_'));
  END LOOP;
END $$;

COMMIT;
