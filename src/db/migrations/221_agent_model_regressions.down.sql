-- Down migration for 221_agent_model_regressions.sql.
-- Drops the model-version regression ledger and its indexes. Idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_instinct_agent_model_regressions_agent;
DROP INDEX IF EXISTS idx_instinct_agent_model_regressions_workspace;
DROP TABLE IF EXISTS instinct_agent_model_regressions;

COMMIT;
