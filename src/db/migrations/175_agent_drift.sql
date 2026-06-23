-- Migration 175: agent behavioral baselines + drift events.
--
-- Agents are unreliable across model changes, so OGIAM keeps them in check.
-- The OGIAM decision ledger records every action an agent took (its outcome,
-- risk tier, and tool), which is the behavioral signal. A baseline captures the
-- agent's normal behavior distribution; a drift check compares a recent window
-- to it and, when behavior shifts past the threshold (rising block rate, a
-- changed risk-tier or tool mix), records a drift event and auto-pauses the
-- agent for owner review. Additive and idempotent.

CREATE TABLE IF NOT EXISTS instinct_agent_baselines (
  agent_id       TEXT         PRIMARY KEY,
  workspace_id   TEXT         NOT NULL,
  -- The captured behavior distribution: block rate, tier mix, outcome mix, tool
  -- mix, over the decisions seen at capture time.
  metrics        JSONB        NOT NULL,
  decision_count INTEGER      NOT NULL,
  captured_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instinct_agent_drift_events (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT         NOT NULL,
  workspace_id TEXT         NOT NULL,
  drift_score  DOUBLE PRECISION NOT NULL,
  -- stable, drifting, critical, or insufficient_data.
  verdict      TEXT         NOT NULL,
  -- none or paused (the agent was auto-paused).
  action       TEXT         NOT NULL DEFAULT 'none',
  metrics      JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instinct_agent_drift_events_agent
  ON instinct_agent_drift_events (agent_id, created_at DESC);
