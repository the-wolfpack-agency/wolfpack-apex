-- 293_ai_code_watch_state.sql
--
-- Memory for the autonomous ci-fix watcher (src/lib/ai-code/watch.ts).
--
-- From 2026-09-30 the watcher re-drove 8 terminal factory PRs every 10 minutes
-- for 10 days, because nothing remembered that a PR had already reached a
-- terminal step. Two tables fix that:
--
--   instinct_ai_code_watch_state  one row per (workspace, repo, PR, head SHA):
--                                 whether that SHA is terminal (sticky) and how
--                                 many drives it has used. A new push is a new
--                                 SHA and earns a fresh look; nothing else does.
--   instinct_ai_code_watch_daily  one row per (workspace, repo, PR, UTC day):
--                                 drives across every SHA, for the daily cap.
--
-- Workspace-scoped, so the tenant-isolation guardrail covers both tables.
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded policies. RLS enabled with a
-- permissive policy, mirroring migration 273. Paired 293_ai_code_watch_state.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_ai_code_watch_state (
  workspace_id    TEXT         NOT NULL,
  repo            TEXT         NOT NULL,
  pr_number       INTEGER      NOT NULL,
  head_sha        TEXT         NOT NULL,
  -- Sticky: once true, no later write sets it back (see WATCH_SQL.recordState).
  terminal        BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Drives that did real work on this SHA ("wait" ticks do not count).
  attempts        INTEGER      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_action     TEXT,
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_driven_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, repo, pr_number, head_sha)
);

CREATE TABLE IF NOT EXISTS instinct_ai_code_watch_daily (
  workspace_id  TEXT     NOT NULL,
  repo          TEXT     NOT NULL,
  pr_number     INTEGER  NOT NULL,
  day           DATE     NOT NULL,
  attempts      INTEGER  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (workspace_id, repo, pr_number, day)
);

ALTER TABLE instinct_ai_code_watch_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_code_watch_state_all ON instinct_ai_code_watch_state;
CREATE POLICY instinct_ai_code_watch_state_all ON instinct_ai_code_watch_state
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE instinct_ai_code_watch_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_code_watch_daily_all ON instinct_ai_code_watch_daily;
CREATE POLICY instinct_ai_code_watch_daily_all ON instinct_ai_code_watch_daily
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_ai_code_watch_state'
       AND column_name IN ('workspace_id','repo','pr_number','head_sha','terminal','attempts','last_action')
  ) = 7, 'instinct_ai_code_watch_state missing expected columns';
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_ai_code_watch_daily'
       AND column_name IN ('workspace_id','repo','pr_number','day','attempts')
  ) = 5, 'instinct_ai_code_watch_daily missing expected columns';
END $$;

COMMIT;
