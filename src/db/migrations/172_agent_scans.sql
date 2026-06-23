-- Migration 172: agent self-onboarding scans (the agent's system model).
--
-- When an agent first logs in it scans the platform and writes the system model
-- it learned: every tool, which ones it may invoke, and its capabilities. Stored
-- so a later agent can inherit the model instead of re-paying the exploration
-- cost (the cumulative-memory plateau). The full model is JSONB; the counts are
-- denormalized for a cheap roster/profile summary. Additive and idempotent.

CREATE TABLE IF NOT EXISTS instinct_agent_scans (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           TEXT         NOT NULL,
  workspace_id       TEXT         NOT NULL,
  scan_version       TEXT         NOT NULL,
  model              JSONB        NOT NULL,
  tool_count         INTEGER      NOT NULL,
  allowed_tool_count INTEGER      NOT NULL,
  capability_count   INTEGER      NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instinct_agent_scans_agent
  ON instinct_agent_scans (agent_id, created_at DESC);
