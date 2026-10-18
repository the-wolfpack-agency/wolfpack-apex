-- 290_ai_code_watch_parked.sql
--
-- The autonomous watcher's memory of a terminal "needs a human" outcome. Without it
-- the watcher re-asked the model to fix the same PR every tick: eight stuck factory
-- PRs on a test repo were re-authored 144 times a day each from 2026-10-08 (about
-- 1M gpt-4o output tokens and $14.50 a day). A PR is parked AT ITS HEAD COMMIT: the
-- watcher skips it while the head is unchanged and drives it again as soon as a
-- human (or anyone) pushes a new commit. One row per (workspace, repo, PR).
--
-- Additive, idempotent.

CREATE TABLE IF NOT EXISTS instinct_ai_code_watch_parked (
  workspace_id  TEXT        NOT NULL,
  repo          TEXT        NOT NULL,
  pr_number     INTEGER     NOT NULL,
  head_sha      TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  reason        TEXT,
  parked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, repo, pr_number)
);
