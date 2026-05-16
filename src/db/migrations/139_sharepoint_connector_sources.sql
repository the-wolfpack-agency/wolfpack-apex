-- Migration 139 — SharePoint connector sources + ingest jobs.
--
-- A SharePoint "source" is a configured folder (site + drive + path) that
-- the user wants Instinct to ingest into the Central Brain on demand. One
-- workspace can have many sources; each source has a sync history.
--
-- Design principles:
--   * Workspace-scoped (workspace_id FK) so multi-tenant isolation is
--     enforced at the row level.
--   * is_active soft-delete; no hard deletes so audit history survives.
--   * last_synced_at lets the UI show "synced 3h ago" without joining
--     to the jobs table for the simple case.
--   * Every sync run records an instinct_sharepoint_ingest_jobs row
--     with started_at, ended_at, file_count, success_count, fail_count
--     so the learning loop and admin UI both see full history.
--   * No silent data loss: jobs that crash mid-run leave a row with
--     status='failed' and the error captured.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_sharepoint_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  name            TEXT NOT NULL,
  site_url        TEXT NOT NULL,
  site_id         TEXT NOT NULL,
  drive_id        TEXT NOT NULL,
  folder_path     TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_sp_sources_workspace
  ON instinct_sharepoint_sources(workspace_id) WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sp_sources_unique_folder
  ON instinct_sharepoint_sources(workspace_id, drive_id, folder_path)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS instinct_sharepoint_ingest_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES instinct_sharepoint_sources(id),
  triggered_by    TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed','partial')),
  file_count      INT NOT NULL DEFAULT 0,
  success_count   INT NOT NULL DEFAULT 0,
  fail_count      INT NOT NULL DEFAULT 0,
  bytes_ingested  BIGINT NOT NULL DEFAULT 0,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sp_jobs_source
  ON instinct_sharepoint_ingest_jobs(source_id, started_at DESC);

COMMENT ON TABLE instinct_sharepoint_sources IS
  'SharePoint folders configured for ingest into the Central Brain.';
COMMENT ON TABLE instinct_sharepoint_ingest_jobs IS
  'Audit log of every sync run. One row per triggered sync, never deleted.';

COMMIT;
