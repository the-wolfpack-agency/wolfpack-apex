-- 033_site_domains.down.sql — reversible teardown of migration 033.
--
-- Drops the Instinct view first (it depends on the table), then the
-- indexes, then the table with its FK + unique constraint. Safe to
-- run even if `up` was applied partially (IF EXISTS everywhere).
--
-- This DOES NOT soft-archive the rows anywhere — run with care. The
-- audit log + apex_events stream already retain the add/remove
-- lifecycle so there is no learning-loop data loss from the teardown.

DROP VIEW IF EXISTS instinct_site_domains;

DROP INDEX IF EXISTS apex_site_domains_added_at_idx;
DROP INDEX IF EXISTS apex_site_domains_status_idx;
DROP INDEX IF EXISTS apex_site_domains_site_idx;

DROP TABLE IF EXISTS apex_site_domains;
