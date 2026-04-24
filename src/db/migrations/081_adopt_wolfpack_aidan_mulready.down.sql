-- 081_adopt_wolfpack_aidan_mulready.down.sql
--
-- Reverse of 081_adopt_wolfpack_aidan_mulready.sql.
-- Deletes the adopted row for the-wolfpack-agency/wolfpack-aidan-mulready.
-- The external GitHub repo is NOT touched — this migration is only about
-- Instinct's internal registry.
--
-- Defensive guards:
--   1. Picks whichever of instinct_site_projects / apex_site_projects is
--      the physical table, so the down works pre- or post-067.
--   2. Missing row = no-op, not an error.
--   3. Row-count assertion: if >1 row exists for the slug (shouldn't —
--      client_slug is UNIQUE — but belt-and-suspenders), refuse to proceed
--      rather than silently deleting multiple rows.

BEGIN;

DO $$
DECLARE
  target_relname TEXT;
  pre_delete_count BIGINT;
  post_delete_count BIGINT;
BEGIN
  SELECT c.relname INTO target_relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema()
     AND c.relkind = 'r'
     AND c.relname IN ('instinct_site_projects', 'apex_site_projects')
   ORDER BY CASE c.relname
              WHEN 'instinct_site_projects' THEN 1
              WHEN 'apex_site_projects' THEN 2
            END
   LIMIT 1;

  IF target_relname IS NULL THEN
    RAISE NOTICE 'Neither instinct_site_projects nor apex_site_projects exists; nothing to reverse.';
    RETURN;
  END IF;

  EXECUTE format(
    'SELECT COUNT(*) FROM %I WHERE client_slug = $1',
    target_relname
  ) USING 'aidan-mulready' INTO pre_delete_count;

  IF pre_delete_count = 0 THEN
    RAISE NOTICE 'aidan-mulready not present in %; nothing to reverse.', target_relname;
    RETURN;
  END IF;

  IF pre_delete_count > 1 THEN
    RAISE EXCEPTION 'Found % rows for client_slug=aidan-mulready in % — refusing to delete; manual inspection required.',
      pre_delete_count, target_relname;
  END IF;

  EXECUTE format(
    'DELETE FROM %I WHERE client_slug = $1',
    target_relname
  ) USING 'aidan-mulready';

  EXECUTE format(
    'SELECT COUNT(*) FROM %I WHERE client_slug = $1',
    target_relname
  ) USING 'aidan-mulready' INTO post_delete_count;

  IF post_delete_count != 0 THEN
    RAISE EXCEPTION 'Reverse-migration post-delete count expected 0, got %; aborting.', post_delete_count;
  END IF;

  RAISE NOTICE 'Reversed adoption: removed aidan-mulready from %.', target_relname;
END $$;

COMMIT;
