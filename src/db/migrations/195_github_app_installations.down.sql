-- Down for 195_github_app_installations.sql
-- Drops the per-workspace GitHub App installation map. Reversible: re-running
-- the up migration recreates an empty table (clients must re-link their App
-- installation; the PAT fallback keeps working in the interim).

BEGIN;

DROP INDEX IF EXISTS idx_github_app_installations_install;
DROP TABLE IF EXISTS github_app_installations;

COMMIT;
