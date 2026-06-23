-- Migration 173: agent tasks (assigned work the agent runs as a governed plan).
--
-- A human assigns work to an agent the same way work is assigned to a teammate.
-- The agent runs it as a multi-step plan, each step authorized by OGIAM under
-- the agent's identity; a refused step blocks the task and escalates to the
-- owner. The step records are JSONB. Additive and idempotent.

CREATE TABLE IF NOT EXISTS instinct_agent_tasks (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       TEXT         NOT NULL,
  workspace_id   TEXT         NOT NULL,
  assigned_by    TEXT         NOT NULL,
  goal           TEXT         NOT NULL,
  status         TEXT         NOT NULL DEFAULT 'queued',
  steps          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  result_summary TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_instinct_agent_tasks_agent
  ON instinct_agent_tasks (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_agent_tasks_workspace_status
  ON instinct_agent_tasks (workspace_id, status, created_at DESC);
