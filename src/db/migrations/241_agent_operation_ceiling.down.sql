DROP INDEX IF EXISTS instinct_agent_operations_workspace_idx;
DROP INDEX IF EXISTS instinct_agent_operations_window_idx;
DROP TABLE IF EXISTS instinct_agent_operations;
ALTER TABLE instinct_agents DROP COLUMN IF EXISTS max_operations_per_hour;
