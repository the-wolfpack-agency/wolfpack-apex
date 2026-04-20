-- Down migration: reverse apex_site_domains → instinct_site_domains
BEGIN;

DO $$
BEGIN
  -- Drop compat view first (it depends on the renamed table)
  EXECUTE 'DROP VIEW IF EXISTS apex_site_domains';


  -- Reverse the rename only if instinct is a table and apex is absent
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_site_domains' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_site_domains' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_site_domains RENAME TO apex_site_domains';
    -- Restore migration-014 alias view
    EXECUTE 'CREATE OR REPLACE VIEW instinct_site_domains AS SELECT * FROM apex_site_domains';
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
    WHERE schemaname = current_schema() AND indexname LIKE 'idx_instinct_site_domains_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname,
                    replace(r.indexname, 'idx_instinct_site_domains_', 'idx_apex_site_domains_'));
  END LOOP;
END $$;

COMMIT;
