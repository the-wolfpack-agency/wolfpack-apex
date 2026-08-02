-- Reverse of 227_agent_containment_state.sql.
DROP INDEX IF EXISTS idx_agent_run_spend_breached;
DROP INDEX IF EXISTS idx_agent_run_spend_workspace;
DROP TABLE IF EXISTS instinct_agent_run_spend;
DROP TABLE IF EXISTS instinct_agent_containment;
