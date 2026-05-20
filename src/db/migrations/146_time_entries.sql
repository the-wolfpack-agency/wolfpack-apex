-- Migration 146 — instinct_time_entries (Hoxsie's time-logging tool).
--
-- Lightweight time-tracking captured via the assistant or the /time
-- page. Hoxsie (CEO) gets a breakdown view at /admin/time across the
-- whole team by user × job_code. Per-user view is at /time.
--
-- Schema notes:
--   - workspace_id + user_id are TEXT (matches the rest of the schema;
--     see migrations 015 / 137 / 142 / 144 — the workspace_id="default"
--     literal pattern).
--   - job_code is free-form TEXT, normalized to UPPERCASE at the lib
--     layer so "wolfpack-auto" and "WOLFPACK-AUTO" group together.
--   - hours uses NUMERIC(5,2) — supports 0.25-hour increments up to
--     999.99 hours per entry. Negative values rejected by CHECK.
--   - logged_for_date is the DATE the work happened, which may differ
--     from created_at (logging yesterday's hours today is normal).
--   - Snapshot user_email + user_role so reports stay legible if the
--     user is later removed from the workspace.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_time_entries (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT         NOT NULL DEFAULT 'default',
  user_id         TEXT         NOT NULL,
  user_email      TEXT,
  user_role       TEXT,
  job_code        TEXT         NOT NULL,
  hours           NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  notes           TEXT,
  logged_for_date DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_workspace_date
  ON instinct_time_entries (workspace_id, logged_for_date DESC);

CREATE INDEX IF NOT EXISTS idx_time_entries_user_date
  ON instinct_time_entries (user_id, logged_for_date DESC);

CREATE INDEX IF NOT EXISTS idx_time_entries_workspace_jobcode
  ON instinct_time_entries (workspace_id, job_code);

COMMENT ON TABLE instinct_time_entries IS
  'Time logged by team members against job codes. Workspace-scoped in the lib layer (src/lib/time-entries.ts). Personal view at /time, admin breakdown at /admin/time.';

COMMIT;
