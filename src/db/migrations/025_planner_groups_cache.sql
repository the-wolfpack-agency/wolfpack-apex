-- Migration 025: Microsoft 365 Groups + Planner local cache (Tier 2 · Stream D)
--
-- Stores per-user Group membership and team-level Planner plans / buckets /
-- tasks pulled from MS Graph. Graph remains the source of truth; writes to
-- Planner (createTask / updateTask / completeTask) are write-through and
-- the mutated task is upserted locally. Reads served from cache so
-- dashboard + Assistant RAG never hit Graph on the hot path.
--
-- Complements Tier 1 personal tasks (instinct_task_lists / instinct_tasks,
-- migration 018). Planner covers team/shared tasks — shape is different
-- enough (bucket column, percent_complete, assignees array) that a separate
-- pair of tables is cleaner than overloading instinct_tasks.
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded.

-- ---------------------------------------------------------------------------
-- Microsoft 365 Groups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_groups (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  ms_group_id    TEXT        NOT NULL,
  display_name   TEXT        NOT NULL DEFAULT '',
  description    TEXT,
  mail_enabled   BOOLEAN     NOT NULL DEFAULT false,
  group_types    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  visibility     TEXT,
  created_at     TIMESTAMPTZ,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_groups_user_ms_unique UNIQUE (user_id, ms_group_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_groups_user_name
  ON instinct_groups (user_id, display_name);

-- ---------------------------------------------------------------------------
-- Planner plans
-- ---------------------------------------------------------------------------
-- Plans can live under a Group (ms_container_type='group') or a Roster
-- (ms_container_type='roster' — plans created without a backing group).
-- group_id is NULL for roster-backed plans.

CREATE TABLE IF NOT EXISTS instinct_planner_plans (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  group_id          UUID        REFERENCES instinct_groups(id) ON DELETE CASCADE,
  ms_plan_id        TEXT        NOT NULL,
  ms_container_id   TEXT,
  ms_container_type TEXT        NOT NULL DEFAULT 'group',
  title             TEXT        NOT NULL DEFAULT '',
  created_by        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ,
  etag              TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_planner_plans_user_ms_unique UNIQUE (user_id, ms_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_planner_plans_user_group
  ON instinct_planner_plans (user_id, group_id);

-- ---------------------------------------------------------------------------
-- Planner buckets (columns in the kanban view)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_planner_buckets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID        NOT NULL REFERENCES instinct_planner_plans(id) ON DELETE CASCADE,
  ms_bucket_id  TEXT        NOT NULL,
  name          TEXT        NOT NULL DEFAULT '',
  order_hint    TEXT,
  etag          TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_planner_buckets_ms_unique UNIQUE (ms_bucket_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_planner_buckets_plan
  ON instinct_planner_buckets (plan_id);

-- ---------------------------------------------------------------------------
-- Planner tasks
-- ---------------------------------------------------------------------------
-- user_id = the viewer who synced this row (same task can appear for
-- multiple users viewing the same shared plan; we cache per-viewer so
-- multi-user queries don't bleed rows across tenants/users).

CREATE TABLE IF NOT EXISTS instinct_planner_tasks (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  plan_id           UUID        NOT NULL REFERENCES instinct_planner_plans(id) ON DELETE CASCADE,
  bucket_id         UUID        REFERENCES instinct_planner_buckets(id) ON DELETE SET NULL,
  ms_task_id        TEXT        NOT NULL,
  title             TEXT        NOT NULL DEFAULT '',
  due_at            TIMESTAMPTZ,
  start_at          TIMESTAMPTZ,
  percent_complete  SMALLINT    NOT NULL DEFAULT 0,
  priority          SMALLINT    NOT NULL DEFAULT 5,
  assignees         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  etag              TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_planner_tasks_user_ms_unique UNIQUE (user_id, ms_task_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_planner_tasks_plan_progress
  ON instinct_planner_tasks (plan_id, percent_complete);

CREATE INDEX IF NOT EXISTS idx_instinct_planner_tasks_user_due
  ON instinct_planner_tasks (user_id, due_at);

CREATE INDEX IF NOT EXISTS idx_instinct_planner_tasks_bucket
  ON instinct_planner_tasks (bucket_id);

-- GIN index on payload for field extraction / assignee search — guarded
-- for PGs without GIN support.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_planner_tasks_payload_gin
             ON instinct_planner_tasks USING GIN (payload)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[025_planner_groups_cache] planner tasks payload GIN skipped: %', SQLERRM;
  END;
END$$;

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_planner_tasks_assignees_gin
             ON instinct_planner_tasks USING GIN (assignees)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[025_planner_groups_cache] planner tasks assignees GIN skipped: %', SQLERRM;
  END;
END$$;
