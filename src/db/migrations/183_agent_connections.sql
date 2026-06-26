-- Migration 183 — bind a workspace CONNECTION to an AGENT.
--
-- An operator builds "a Salesforce agent", "a Jira agent", etc. by associating
-- one or more workspace connector credentials (migration 136 +
-- instinct_connector_credentials) with an agent principal (migration 171 +
-- instinct_agents). This is purely an ASSOCIATION layer: the connection itself
-- stays workspace-scoped and reusable — many agents can bind the same
-- connector, and unbinding an agent never touches the credential row.
--
-- Design:
--   - (workspace_id, agent_id, connector_name) is unique so a bind is
--     idempotent (the store INSERTs ON CONFLICT DO NOTHING).
--   - connector_name references instinct_connector_credentials by NAME, not by
--     FK, mirroring how the rest of the connector layer addresses credentials
--     (the credential row may be env-fallback-only and absent from the table).
--   - Index on (workspace_id, agent_id) backs the hot "what is this agent bound
--     to" read and the roster group-by.
--
-- No silent data loss (per feedback_no_silent_data_loss):
--   * Idempotent CREATE TABLE / CREATE INDEX so re-runs are safe.
--   * created_by + created_at retain who associated the connection and when.
--   * Down migration drops the association table only; credentials + agents are
--     never touched.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_agent_connections (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT         NOT NULL DEFAULT 'default',
  agent_id       TEXT         NOT NULL,
  connector_name TEXT         NOT NULL,
  created_by     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT instinct_agent_connections_unique
    UNIQUE (workspace_id, agent_id, connector_name)
);

-- Hot lookup: "what connections is this agent bound to" + roster group-by.
CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace_agent
  ON instinct_agent_connections (workspace_id, agent_id);

COMMIT;
