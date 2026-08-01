-- Reverse of 226_site_acceptance.sql.
DROP INDEX IF EXISTS idx_site_acceptance_runs_queued;
DROP INDEX IF EXISTS idx_site_acceptance_runs_project;
DROP INDEX IF EXISTS uq_site_acceptance_runs_deploy;
DROP TABLE IF EXISTS instinct_site_acceptance_runs;
DROP INDEX IF EXISTS idx_site_acceptance_workspace;
DROP TABLE IF EXISTS instinct_site_acceptance;
