-- 273_ai_code_watched_repos.sql
--
-- SaaS config for the autonomous ci-fix watcher: which repos each WORKSPACE has
-- enrolled. Replaces the single-tenant AI_CODE_WATCH_REPOS env var (kept only as
-- an additive bootstrap fallback) so a client enrolls a repo once through the UI /
-- API and ONE deployment serves every workspace - no per-project env vars.
--
-- The cron reads every ENABLED row across workspaces and drives each workspace's
-- factory PRs with that workspace's own credentials + entitlement. Workspace-
-- scoped, so the repo-wide tenant-isolation guardrail covers it.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- deny-by-default tripwire + permissive policy, mirroring migration 212.
-- Paired 273_ai_code_watched_repos.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_ai_code_watched_repos (
  workspace_id  TEXT         NOT NULL,
  -- owner/name of the repo to watch.
  repo          TEXT         NOT NULL,
  -- A client can pause a repo without un-enrolling it.
  enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- One row per (workspace, repo): a client cannot enroll the same repo twice, and
  -- one workspace's enrollment never collides with another's.
  PRIMARY KEY (workspace_id, repo)
);

-- The cron's hot path: every enabled row across all workspaces.
CREATE INDEX IF NOT EXISTS idx_ai_code_watched_enabled
  ON instinct_ai_code_watched_repos (enabled) WHERE enabled;

ALTER TABLE instinct_ai_code_watched_repos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_code_watched_repos_all ON instinct_ai_code_watched_repos;
CREATE POLICY instinct_ai_code_watched_repos_all ON instinct_ai_code_watched_repos
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_ai_code_watched_repos'
       AND column_name IN ('workspace_id','repo','enabled','created_at','updated_at')
  ) = 5, 'instinct_ai_code_watched_repos missing expected columns';
END $$;

COMMIT;
