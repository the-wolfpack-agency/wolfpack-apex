-- 227_agent_containment_state.sql
--
-- Where the agent stop lives, and where one run's spend is counted.
--
-- The containment library (migration-less, shipped in #213) can decide whether
-- a run may take another step. It had nowhere to read the answer from, so it
-- decided nothing. These two tables are that missing half.
--
-- WHY A TABLE AND NOT AN ENV VAR
--
-- An environment variable takes a redeploy to change, and a stop that takes a
-- redeploy is not a stop — it is a preference with a deployment pipeline in
-- front of it. The whole point of the control is that a person can halt agent
-- work NOW, from the UI, and have the next step see it.
--
-- FAIL-CLOSED READS
--
-- The app treats an unreadable state as STOPPED, so a missing row must not read
-- as "running". The row is therefore created by this migration with agents
-- enabled, rather than relying on absence to mean anything: absence and
-- disabled are different, and only one of them is safe to guess at.
--
-- Tenant model: workspace_id TEXT on both, filtered explicitly in every query
-- (the repo-wide tenant-isolation scan requires the predicate to be visible in
-- the query rather than implied).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS instinct_agent_containment (
  workspace_id   TEXT PRIMARY KEY,
  -- False halts every agent step in this workspace, checked before each one.
  agents_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Why it was stopped, so whoever finds it stopped knows whether to restart it.
  stopped_reason TEXT,
  stopped_by     TEXT,
  stopped_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The default workspace starts enabled and EXPLICIT. Relying on a missing row
-- to mean "enabled" would make absence meaningful, and the read path is
-- deliberately fail-closed.
INSERT INTO instinct_agent_containment (workspace_id, agents_enabled)
VALUES ('default', TRUE)
ON CONFLICT (workspace_id) DO NOTHING;

-- One row per agent run: what it has spent so far. Written as the run proceeds
-- so a step can be refused BEFORE it happens rather than reported after.
CREATE TABLE IF NOT EXISTS instinct_agent_run_spend (
  run_id        TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  agent_id      TEXT,
  tokens        INT NOT NULL DEFAULT 0,
  duration_ms   INT NOT NULL DEFAULT 0,
  egress_calls  INT NOT NULL DEFAULT 0,
  spend_cents   INT NOT NULL DEFAULT 0,
  -- The ceiling this run was given, kept alongside the spend so a later reader
  -- can tell whether a run was stopped by the default or by a raised limit
  -- someone chose. A budget without its own record is unauditable.
  budget        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Set when a run was halted, naming which ceiling it hit.
  breached      TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_spend_workspace
  ON instinct_agent_run_spend (workspace_id, started_at DESC);

-- Runs stopped by a ceiling, newest first: the view that answers "are our
-- budgets set right, or are they just stopping real work".
CREATE INDEX IF NOT EXISTS idx_agent_run_spend_breached
  ON instinct_agent_run_spend (workspace_id, started_at DESC)
  WHERE breached IS NOT NULL;
