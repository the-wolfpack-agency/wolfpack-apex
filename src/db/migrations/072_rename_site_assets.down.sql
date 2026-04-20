-- Down migration: reverse apex_site_assets → instinct_site_assets
BEGIN;

DO $$
BEGIN
  -- Drop compat view first (it depends on the renamed table)
  EXECUTE 'DROP VIEW IF EXISTS apex_site_assets';


  -- Reverse the rename only if instinct is a table and apex is absent
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_site_assets' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_site_assets' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_site_assets RENAME TO apex_site_assets';
    -- Restore migration-014 alias view
    EXECUTE 'CREATE OR REPLACE VIEW instinct_site_assets AS SELECT * FROM apex_site_assets';
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
    WHERE schemaname = current_schema() AND indexname LIKE 'idx_instinct_site_assets_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname,
                    replace(r.indexname, 'idx_instinct_site_assets_', 'idx_apex_site_assets_'));
  END LOOP;
END $$;

COMMIT;
