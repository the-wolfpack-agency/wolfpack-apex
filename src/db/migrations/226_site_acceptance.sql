-- 226_site_acceptance.sql
--
-- Acceptance criteria for a generated site, and the record of every attempt to
-- meet them.
--
-- The wireframe path could already build and deploy a site. What it could not do
-- is say whether the result was right, so a person compared the deploy to the
-- prototype by eye and sent a correction in prose. Each of those rounds is a
-- manual test cycle, and prose is the least repeatable input a build can take.
-- These two tables replace that: the requirement is a stored object with
-- validated fields, and the check against it is a machine run whose outcome is
-- kept whether it passed, failed, or could not be performed.
--
-- Keeping the failures is the point. "Which intakes produce a first-pass-clean
-- build, and which criteria actually catch anything" is a question about the
-- runs that went badly; discarding them would leave only the flattering half of
-- the data. No data lost.
--
-- Tenant model: workspace_id on both tables, filtered explicitly in every query
-- (the repo-wide tenant-isolation scan requires the predicate to be visible in
-- the query, not implied by a join). TEXT, not UUID: workspace ids are TEXT
-- throughout this schema and the API falls back to the literal 'default'.
--
-- Idempotent.

-- One criteria row per project: the contract the build is measured against.
CREATE TABLE IF NOT EXISTS instinct_site_acceptance (
  project_id     TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  -- The prototype, when there is one. Nullable on purpose: plenty of intakes
  -- arrive as a wireframe image with nothing hosted, and every other check
  -- still applies to those.
  prototype_url  TEXT,
  -- The validated AcceptanceCriteria object (see src/lib/site-acceptance/criteria.ts).
  -- JSONB because the app layer owns the shape and evolves it; the columns above
  -- and below are the ones queries actually filter and trend on.
  criteria       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- How much of the contract the intake filled in, 0 to 1. Stored rather than
  -- derived so "did a more complete intake produce a cleaner build" is one query.
  completeness   NUMERIC NOT NULL DEFAULT 0,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_acceptance_workspace
  ON instinct_site_acceptance (workspace_id, updated_at DESC);

-- One row per attempt. A row is created the moment a deploy succeeds, BEFORE any
-- checking happens, so an attempt that never ran is still visible as queued
-- rather than absent. Absence and "we did not look" are the two states this
-- whole layer exists to stop being confused with success.
CREATE TABLE IF NOT EXISTS instinct_site_acceptance_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  -- The deploy this judges. One acceptance run per deploy: re-running replaces
  -- nothing, it adds a row, so the before/after of a fix survives.
  deploy_id      TEXT NOT NULL,
  deployed_url   TEXT,
  -- queued  : recorded, not yet checked
  -- running  : a runner has claimed it
  -- passed   : every enforced check passed
  -- failed   : at least one check failed
  -- degraded : at least one check could not be measured, which is NOT a pass
  status         TEXT NOT NULL DEFAULT 'queued',
  -- The full verdict: every check, its status, its evidence.
  verdict        JSONB,
  -- Set when the layout comparison ran, so a run links to its measurements.
  spec_diff_run_id UUID,
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT,
  duration_ms    INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

-- Guard the status vocabulary in the database as well as the app: a typo in a
-- writer would otherwise create a status nothing queries and nothing reports.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'instinct_site_acceptance_runs_status_chk'
  ) THEN
    ALTER TABLE instinct_site_acceptance_runs
      ADD CONSTRAINT instinct_site_acceptance_runs_status_chk
      CHECK (status IN ('queued', 'running', 'passed', 'failed', 'degraded'));
  END IF;
END$$;

-- One deploy is judged once. Re-queueing the same deploy must not create a
-- second pending row that a drain would run twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_acceptance_runs_deploy
  ON instinct_site_acceptance_runs (deploy_id);

-- The project timeline: this project's attempts, newest first.
CREATE INDEX IF NOT EXISTS idx_site_acceptance_runs_project
  ON instinct_site_acceptance_runs (workspace_id, project_id, created_at DESC);

-- The drain: the oldest work still waiting, across the workspace.
CREATE INDEX IF NOT EXISTS idx_site_acceptance_runs_queued
  ON instinct_site_acceptance_runs (status, created_at)
  WHERE status IN ('queued', 'running');
