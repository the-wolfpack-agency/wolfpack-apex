-- Migration 018: Microsoft 365 Tasks (To Do) local cache
--
-- Stores per-user todoTaskList + todoTask data fetched from MS Graph so
-- that reads do not hit Graph on the hot path. Graph remains the source
-- of truth — writes go through Graph and are mirrored here (write-through);
-- webhook notifications trigger re-sync to keep the cache fresh.
--
-- Cross-module analytics (meetings ↔ tasks, HR ↔ tasks, journal ↔ tasks)
-- join on these tables without another Graph round-trip.
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded.

CREATE TABLE IF NOT EXISTS instinct_task_lists (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,
  ms_list_id    TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  is_owner      BOOLEAN     NOT NULL DEFAULT true,
  is_shared     BOOLEAN     NOT NULL DEFAULT false,
  etag          TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_task_lists_user_ms_unique UNIQUE (user_id, ms_list_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_task_lists_user
  ON instinct_task_lists (user_id);

CREATE TABLE IF NOT EXISTS instinct_tasks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,
  ms_task_id    TEXT        NOT NULL,
  list_id       UUID        NOT NULL REFERENCES instinct_task_lists(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL,
  body          TEXT,
  status        TEXT        NOT NULL,
  importance    TEXT        NOT NULL DEFAULT 'normal',
  due_at        TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  etag          TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_tasks_user_ms_unique UNIQUE (user_id, ms_task_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_tasks_user_due
  ON instinct_tasks (user_id, due_at);

CREATE INDEX IF NOT EXISTS idx_instinct_tasks_user_status
  ON instinct_tasks (user_id, status);

CREATE INDEX IF NOT EXISTS idx_instinct_tasks_list_status
  ON instinct_tasks (list_id, status);

CREATE INDEX IF NOT EXISTS idx_instinct_tasks_user_updated
  ON instinct_tasks (user_id, updated_at DESC);

-- GIN on payload for future field extraction without another Graph call.
-- Guarded with DO block so builds against PGs without GIN support keep moving.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_tasks_payload_gin ON instinct_tasks USING GIN (payload)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[018_ms_tasks] GIN index skipped: %', SQLERRM;
  END;
END$$;
